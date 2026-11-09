// Teams: shared ownership for an app's data. Roles are opt-in and modeled by the
// app — the default `["owner", "admin", "member"]` list is ordered most-powerful
// first, and apps can rename it or drop the middle tier entirely.
//
//   // onebase/components.ts
//   export default defineComponents({ teams: teams({ roles: ["owner", "admin", "member"] }) });
//
//   // app function, inside a transaction
//   const teamId = await ctx.components.teams.ensureTeam({ userId, name: "Personal" });
//   const role = await ctx.components.teams.role({ teamId, userId });
//   assertRole(role, ["admin"]); // throws OneBaseError when the caller can't act
//
// Queries (`myTeams`, `members`, `role`) are live: clients see membership change
// as it happens when the app exposes them.

import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "onebase/components";
import { OneBaseError, defineSchema, defineTable, type DataModelFromSchema } from "onebase/server";
import { v } from "onebase/values";

export type TeamsConfig = {
  /** Role names, most powerful first (default `["owner", "admin", "member"]`). */
  roles?: string[];
  /** The role that may manage members (default `"admin"`). */
  manageRole?: string;
  /** The role new members get (default `"member"`). */
  joinRole?: string;
};

const schema = defineSchema({
  teams: defineTable({
    name: v.string(),
    ownerId: v.string(),
    createdAtMs: v.number(),
  }).index("by_owner", ["ownerId"]),
  members: defineTable({
    teamId: v.string(),
    userId: v.string(),
    role: v.string(),
    createdAtMs: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_team_user", ["teamId", "userId"]),
});

const { mutation, query } = componentServer<DataModelFromSchema<typeof schema>, TeamsConfig>();

const DEFAULT_ROLES = ["owner", "admin", "member"];

const rolesOf = (config: TeamsConfig): string[] => config.roles ?? DEFAULT_ROLES;
const manageRoleOf = (config: TeamsConfig) => config.manageRole ?? "admin";
const joinRoleOf = (config: TeamsConfig) => config.joinRole ?? "member";

/** Lower is more powerful; unknown roles rank below everything so renamed roles fail closed. */
const rankOf = (config: TeamsConfig, role: string) => {
  const index = rolesOf(config).indexOf(role);
  return index === -1 ? rolesOf(config).length : index;
};

const findMember = async (ctx: any, teamId: string, userId: string) =>
  ctx.db.query("members").withIndex("by_team_user", (q: any) => q.eq("teamId", teamId).eq("userId", userId)).unique();

async function countOwners(ctx: any, config: TeamsConfig, teamId: string) {
  const rows = await ctx.db.query("members").withIndex("by_team_user", (q: any) => q.eq("teamId", teamId)).collect();
  return rows.filter((row: any) => row.role === rolesOf(config)[0]).length;
}

/** The acting member's role, or throws when they aren't a member at all. */
async function actingRole(ctx: any, config: TeamsConfig, teamId: string, by: string) {
  const member = await findMember(ctx, teamId, by);
  if (!member) throw new OneBaseError("You are not a member of this team.");
  return member.role as string;
}

function requireManage(config: TeamsConfig, role: string) {
  if (rankOf(config, role) > rankOf(config, manageRoleOf(config))) {
    throw new OneBaseError(`Requires the ${manageRoleOf(config)} role or higher.`);
  }
}

/** A member may only act on members strictly below their own rank, unless they are the top role. */
function requireOver(config: TeamsConfig, actingRole: string, targetRole: string | undefined) {
  const isTop = rankOf(config, actingRole) === 0;
  if (isTop) return;
  if (targetRole !== undefined && rankOf(config, targetRole) <= rankOf(config, actingRole)) {
    throw new OneBaseError(`Only the ${rolesOf(config)[0]} can act on a ${targetRole}.`);
  }
}

const createTeam = mutation({
  args: { userId: v.string(), name: v.string() },
  handler: async (ctx, { userId, name }) => {
    // Insert ids are branded in the type system; our tables store team ids as plain strings.
    const teamId = (await ctx.db.insert("teams", { name, ownerId: userId, createdAtMs: Date.now() })) as unknown as string;
    await ctx.db.insert("members", { teamId, userId, role: rolesOf(ctx.config)[0]!, createdAtMs: Date.now() });
    return teamId;
  },
});

/** The user's team with this exact name, created if missing — a self-healing per-user team. */
const ensureTeam = mutation({
  args: { userId: v.string(), name: v.string() },
  handler: async (ctx, { userId, name }) => {
    const owned = await ctx.db.query("teams").withIndex("by_owner", (q: any) => q.eq("ownerId", userId)).collect();
    const team = owned.find((row: any) => row.name === name);
    if (team) return team._id as string;
    return createTeam.handler(ctx, { userId, name });
  },
});

const addMember = mutation({
  args: { teamId: v.string(), userId: v.string(), role: v.optional(v.string()), by: v.string() },
  handler: async (ctx, { teamId, userId, role, by }) => {
    if (!((await ctx.db.get(teamId as any)) as any)) throw new OneBaseError("No such team.");
    const acting = await actingRole(ctx, ctx.config, teamId, by);
    requireManage(ctx.config, acting);
    const finalRole = role ?? joinRoleOf(ctx.config);
    if (!rolesOf(ctx.config).includes(finalRole)) throw new OneBaseError(`Unknown role "${finalRole}".`);
    if (rankOf(ctx.config, finalRole) < rankOf(ctx.config, acting)) {
      throw new OneBaseError("You can't grant a role above your own.");
    }
    if (await findMember(ctx, teamId, userId)) throw new OneBaseError("Already a member.");
    await ctx.db.insert("members", { teamId, userId, role: finalRole, createdAtMs: Date.now() });
    return null;
  },
});

const setRole = mutation({
  args: { teamId: v.string(), userId: v.string(), role: v.string(), by: v.string() },
  handler: async (ctx, { teamId, userId, role, by }) => {
    const member = await findMember(ctx, teamId, userId);
    if (!member) throw new OneBaseError("Not a member.");
    const acting = await actingRole(ctx, ctx.config, teamId, by);
    requireManage(ctx.config, acting);
    requireOver(ctx.config, acting, member.role as string);
    if (!rolesOf(ctx.config).includes(role)) throw new OneBaseError(`Unknown role "${role}".`);
    const topRole = rolesOf(ctx.config)[0];
    if (
      member.role === topRole &&
      role !== topRole &&
      (await countOwners(ctx, ctx.config, teamId)) === 1
    ) {
      throw new OneBaseError("Can't demote the only owner; promote someone else first.");
    }
    await ctx.db.patch(member._id, { role });
    return null;
  },
});

const removeMember = mutation({
  args: { teamId: v.string(), userId: v.string(), by: v.string() },
  handler: async (ctx, { teamId, userId, by }) => {
    const member = await findMember(ctx, teamId, userId);
    if (!member) throw new OneBaseError("Not a member.");
    const acting = await actingRole(ctx, ctx.config, teamId, by);
    requireManage(ctx.config, acting);
    requireOver(ctx.config, acting, member.role as string);
    const topRole = rolesOf(ctx.config)[0];
    if (member.role === topRole && (await countOwners(ctx, ctx.config, teamId)) === 1) {
      throw new OneBaseError("Can't remove the only owner.");
    }
    await ctx.db.delete(member._id);
    return null;
  },
});

const leave = mutation({
  args: { teamId: v.string(), userId: v.string() },
  handler: async (ctx, { teamId, userId }) => {
    const member = await findMember(ctx, teamId, userId);
    if (!member) throw new OneBaseError("Not a member.");
    const topRole = rolesOf(ctx.config)[0];
    if (member.role === topRole && (await countOwners(ctx, ctx.config, teamId)) === 1) {
      throw new OneBaseError("The only owner can't leave; promote someone else or delete the team.");
    }
    await ctx.db.delete(member._id);
    return null;
  },
});

const deleteTeam = mutation({
  args: { teamId: v.string(), by: v.string() },
  handler: async (ctx, { teamId, by }) => {
    const team = (await ctx.db.get(teamId as any)) as any;
    if (!team) throw new OneBaseError("No such team.");
    const acting = await actingRole(ctx, ctx.config, teamId, by);
    if (rankOf(ctx.config, acting) !== 0) throw new OneBaseError(`Only the ${rolesOf(ctx.config)[0]} can delete a team.`);
    const rows = await ctx.db.query("members").withIndex("by_team_user", (q: any) => q.eq("teamId", teamId)).collect();
    for (const row of rows) await ctx.db.delete(row._id);
    await ctx.db.delete(team._id);
    return null;
  },
});

/** The user's teams with their role in each; a live query. */
const myTeams = query({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db.query("members").withIndex("by_user", (q: any) => q.eq("userId", userId)).collect();
    const out = [];
    for (const row of rows) {
      // teamId is stored as a plain string (ids cross component boundaries as strings).
      const team = (await ctx.db.get(row.teamId as any)) as any;
      if (!team) continue;
      out.push({ teamId: row.teamId as string, name: team.name as string, role: row.role as string, createdAtMs: team.createdAtMs as number });
    }
    return out;
  },
});

/** A team's members, oldest first; a live query. */
const members = query({
  args: { teamId: v.string() },
  handler: async (ctx, { teamId }) => {
    const rows = await ctx.db.query("members").withIndex("by_team_user", (q: any) => q.eq("teamId", teamId)).collect();
    return rows
      .sort((a: any, b: any) => a.createdAtMs - b.createdAtMs)
      .map((row: any) => ({ userId: row.userId as string, role: row.role as string, createdAtMs: row.createdAtMs as number }));
  },
});

/** The user's role in the team, or null when they aren't a member; a live query. */
const role = query({
  args: { teamId: v.string(), userId: v.string() },
  handler: async (ctx, { teamId, userId }) => {
    const member = await findMember(ctx, teamId, userId);
    return member ? (member.role as string) : null;
  },
});

export const definition = defineComponent({
  name: "teams",
  schema,
  functions: { createTeam, ensureTeam, addMember, setRole, removeMember, leave, deleteTeam, myTeams, members, role },
  checkConfig: (config: TeamsConfig) => {
    const roles = rolesOf(config);
    if (roles.length === 0 || roles.some((role) => typeof role !== "string" || role.length === 0)) {
      throw new Error("teams({ roles }) needs non-empty role names.");
    }
    if (new Set(roles).size !== roles.length) throw new Error("teams({ roles }) must be unique.");
    for (const key of ["manageRole", "joinRole"] as const) {
      const value = config[key];
      if (value !== undefined && !roles.includes(value)) {
        throw new Error(`teams({ ${key} }) must be one of roles.`);
      }
    }
  },
});

// ---- Types for the app ----

export type TeamSummary = { teamId: string; name: string; role: string; createdAtMs: number };
export type TeamMember = { userId: string; role: string; createdAtMs: number };

export type TeamsApi = {
  createTeam: ComponentFn<"mutation", (args: { userId: string; name: string }) => Promise<string>>;
  ensureTeam: ComponentFn<"mutation", (args: { userId: string; name: string }) => Promise<string>>;
  addMember: ComponentFn<"mutation", (args: { teamId: string; userId: string; role?: string; by: string }) => Promise<null>>;
  setRole: ComponentFn<"mutation", (args: { teamId: string; userId: string; role: string; by: string }) => Promise<null>>;
  removeMember: ComponentFn<"mutation", (args: { teamId: string; userId: string; by: string }) => Promise<null>>;
  leave: ComponentFn<"mutation", (args: { teamId: string; userId: string }) => Promise<null>>;
  deleteTeam: ComponentFn<"mutation", (args: { teamId: string; by: string }) => Promise<null>>;
  myTeams: ComponentFn<"query", (args: { userId: string }) => Promise<TeamSummary[]>>;
  members: ComponentFn<"query", (args: { teamId: string }) => Promise<TeamMember[]>>;
  role: ComponentFn<"query", (args: { teamId: string; userId: string }) => Promise<string | null>>;
};

/** Throws `OneBaseError` when `role` isn't one of the allowed roles (null means "not a member"). */
export function assertRole(role: string | null, allowed: string[]) {
  if (role === null || !allowed.includes(role)) {
    throw new OneBaseError(`Requires one of: ${allowed.join(", ")}.`);
  }
}

/** Mounts teams: `teams({ roles: ["owner", "admin", "member"] })`. */
export function teams<const E extends keyof TeamsApi = never>(opts: TeamsConfig & MountOptions<E> = {}): Mount<TeamsApi, E> {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config, options) as unknown as Mount<TeamsApi, E>;
}
