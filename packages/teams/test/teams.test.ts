// Teams: role matrix, last-owner protection, self-healing teams, and custom role lists.
// Component functions are called through a passthrough app module, exactly the way
// an app's own functions would call them.

import { describe, expect, test } from "bun:test";
import { defineComponents } from "onebase/components";
import { defineSchema, mutation, query } from "onebase/server";
import { v } from "onebase/values";
import { teams } from "../src/index";
import { openRuntime, type TestApp } from "../../../test/app";

const appSchema = defineSchema({});

function passthrough() {
  return {
    t: {
      create: mutation({
        args: { userId: v.string(), name: v.string() },
        handler: (ctx: any, a) => ctx.components.teams.createTeam(a),
      }),
      ensure: mutation({
        args: { userId: v.string(), name: v.string() },
        handler: (ctx: any, a) => ctx.components.teams.ensureTeam(a),
      }),
      add: mutation({
        args: { teamId: v.string(), userId: v.string(), role: v.optional(v.string()), by: v.string() },
        handler: (ctx: any, a) => ctx.components.teams.addMember(a),
      }),
      setRole: mutation({
        args: { teamId: v.string(), userId: v.string(), role: v.string(), by: v.string() },
        handler: (ctx: any, a) => ctx.components.teams.setRole(a),
      }),
      remove: mutation({
        args: { teamId: v.string(), userId: v.string(), by: v.string() },
        handler: (ctx: any, a) => ctx.components.teams.removeMember(a),
      }),
      leave: mutation({
        args: { teamId: v.string(), userId: v.string() },
        handler: (ctx: any, a) => ctx.components.teams.leave(a),
      }),
      deleteTeam: mutation({
        args: { teamId: v.string(), by: v.string() },
        handler: (ctx: any, a) => ctx.components.teams.deleteTeam(a),
      }),
      myTeams: query({
        args: { userId: v.string() },
        handler: (ctx: any, a) => ctx.components.teams.myTeams(a),
      }),
      members: query({
        args: { teamId: v.string() },
        handler: (ctx: any, a) => ctx.components.teams.members(a),
      }),
      role: query({
        args: { teamId: v.string(), userId: v.string() },
        handler: (ctx: any, a) => ctx.components.teams.role(a),
      }),
    },
  };
}

// Queries come back wrapped ({ value }) through the runtime; mutations return their value directly.
const q = (app: TestApp, name: string, args: object) => app.runtime.runQuery(name, args).then((r) => r.value);

async function open() {
  return openRuntime({ schema: appSchema, modules: passthrough(), components: defineComponents({ teams: teams() }) as any });
}

async function seeded() {
  const app = await open();
  const teamId = (await app.runtime.runMutation("t:create", { userId: "u-owner", name: "Acme" })) as string;
  await app.runtime.runMutation("t:add", { teamId, userId: "u-admin", role: "admin", by: "u-owner" });
  await app.runtime.runMutation("t:add", { teamId, userId: "u-member", by: "u-admin" });
  return { app, teamId };
}

describe("teams", () => {
  test("create makes the creator the owner; queries see it", async () => {
    const { app, teamId } = await seeded();
    try {
      expect(await q(app, "t:role", { teamId, userId: "u-owner" })).toBe("owner");
      expect(await q(app, "t:myTeams", { userId: "u-owner" })).toEqual([
        { teamId, name: "Acme", role: "owner", createdAtMs: expect.any(Number) },
      ]);
      expect(await q(app, "t:members", { teamId })).toEqual([
        { userId: "u-owner", role: "owner", createdAtMs: expect.any(Number) },
        { userId: "u-admin", role: "admin", createdAtMs: expect.any(Number) },
        { userId: "u-member", role: "member", createdAtMs: expect.any(Number) },
      ]);
    } finally {
      await app.close();
    }
  });

  test("ensureTeam is idempotent per owner and name", async () => {
    const app = await open();
    try {
      const a = (await app.runtime.runMutation("t:ensure", { userId: "u1", name: "Personal" })) as string;
      const b = (await app.runtime.runMutation("t:ensure", { userId: "u1", name: "Personal" })) as string;
      const other = (await app.runtime.runMutation("t:ensure", { userId: "u2", name: "Personal" })) as string;
      expect(a).toBe(b);
      expect(a).not.toBe(other);
    } finally {
      await app.close();
    }
  });

  test("members can't manage, admins can, but admins can't grant above themselves", async () => {
    const { app, teamId } = await seeded();
    try {
      await expect(
        app.runtime.runMutation("t:add", { teamId, userId: "u-x", by: "u-member" }),
      ).rejects.toThrow("Requires the admin role");
      await app.runtime.runMutation("t:add", { teamId, userId: "u-y", by: "u-admin" });
      await expect(
        app.runtime.runMutation("t:add", { teamId, userId: "u-z", role: "owner", by: "u-admin" }),
      ).rejects.toThrow("can't grant a role above your own");
      await app.runtime.runMutation("t:add", { teamId, userId: "u-z", role: "owner", by: "u-owner" });
      await expect(
        app.runtime.runMutation("t:setRole", { teamId, userId: "u-owner", role: "member", by: "u-admin" }),
      ).rejects.toThrow("Only the owner can act on a owner");
    } finally {
      await app.close();
    }
  });

  test("the last owner can't be demoted, removed, or leave", async () => {
    const { app, teamId } = await seeded();
    try {
      await expect(
        app.runtime.runMutation("t:setRole", { teamId, userId: "u-owner", role: "member", by: "u-owner" }),
      ).rejects.toThrow("Can't demote the only owner");
      await expect(
        app.runtime.runMutation("t:remove", { teamId, userId: "u-owner", by: "u-admin" }),
      ).rejects.toThrow("Only the owner can act on a owner");
      await expect(app.runtime.runMutation("t:leave", { teamId, userId: "u-owner" })).rejects.toThrow(
        "only owner can't leave",
      );
      // After promoting a second owner, the original can leave.
      await app.runtime.runMutation("t:setRole", { teamId, userId: "u-admin", role: "owner", by: "u-owner" });
      await app.runtime.runMutation("t:leave", { teamId, userId: "u-owner" });
      expect(await q(app, "t:role", { teamId, userId: "u-owner" })).toBeNull();
    } finally {
      await app.close();
    }
  });

  test("deleteTeam is owner-only and cascades", async () => {
    const { app, teamId } = await seeded();
    try {
      await expect(app.runtime.runMutation("t:deleteTeam", { teamId, by: "u-admin" })).rejects.toThrow(
        "Only the owner can delete",
      );
      await app.runtime.runMutation("t:deleteTeam", { teamId, by: "u-owner" });
      expect(await q(app, "t:members", { teamId })).toEqual([]);
      expect(await q(app, "t:myTeams", { userId: "u-owner" })).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test("roles are opt-in: a custom list renames every rule", async () => {
    const config = { roles: ["chief", "crew"], manageRole: "chief", joinRole: "crew" };
    const app = await openRuntime({
      schema: appSchema,
      modules: passthrough(),
      components: defineComponents({ teams: teams(config) }) as any,
    });
    try {
      const teamId = (await app.runtime.runMutation("t:create", { userId: "u1", name: "Ship" })) as string;
      expect(await q(app, "t:role", { teamId, userId: "u1" })).toBe("chief");
      await app.runtime.runMutation("t:add", { teamId, userId: "u2", by: "u1" });
      expect(await q(app, "t:role", { teamId, userId: "u2" })).toBe("crew");
      // "admin" is not a role here.
      await expect(
        app.runtime.runMutation("t:add", { teamId, userId: "u3", role: "admin", by: "u1" }),
      ).rejects.toThrow('Unknown role "admin"');
      await expect(
        app.runtime.runMutation("t:add", { teamId, userId: "u3", by: "u2" }),
      ).rejects.toThrow("Requires the chief role");
    } finally {
      await app.close();
    }
  });
});
