# @onebase/teams

Teams give your app's data shared owners. A user creates a team and becomes its owner, adds members with a role, and every member sees the team in a live list. Roles are just ordered names, so you can keep the default `owner`, `admin` and `member`, rename them, or drop the middle one.

## Install

```bash
bun add @onebase/teams
```

Until the package is on npm, depend on a checkout of this repository instead: `bun add @onebase/teams@file:../onebase-components/packages/teams`.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { teams } from "@onebase/teams";

export default defineComponents({
  teams: teams({ roles: ["owner", "admin", "member"] }),
});
```

| Option | Default | |
|---|---|---|
| `roles` | `["owner", "admin", "member"]` | Role names, most powerful first. The first one is the owner role. |
| `manageRole` | `"admin"` | The lowest role that can add, remove and change members. |
| `joinRole` | `"member"` | The role `addMember` gives when you don't pass one. |

## Use it

The component doesn't read the caller's identity: every function takes the user it acts for (`userId`, or `by` for the member doing the managing). Read that from your own auth and pass it in.

```ts
// onebase/teams.ts
import { mutation, query, getAuthUserId } from "onebase/server";
import { v } from "onebase/values";
import { assertRole } from "@onebase/teams";

export const invite = mutation({
  args: { teamId: v.string(), userId: v.string() },
  handler: async (ctx, { teamId, userId }) => {
    const me = await getAuthUserId(ctx);
    if (!me) throw new Error("Sign in first.");
    await ctx.components.teams.addMember({ teamId, userId, by: me });
  },
});

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const me = await getAuthUserId(ctx);
    return me ? ctx.components.teams.myTeams({ userId: me }) : [];
  },
});

// Gate your own data on a role:
const role = await ctx.components.teams.role({ teamId, userId: me });
assertRole(role, ["owner", "admin"]); // throws ConvexError otherwise
```

`ensureTeam({ userId, name })` returns the user's team with that name and creates it when it's missing, which suits a personal team made on first sign-in.

Don't `expose` the mutations to clients: they trust the `by` and `userId` they're given, so a client could act as anyone. Wrap them as above. Exposing the queries is safe only if any signed-in user may see any team's members.

## Functions

| | |
|---|---|
| `createTeam({ userId, name })` | Mutation. Creates a team with `userId` as its owner and returns the team id. |
| `ensureTeam({ userId, name })` | Mutation. The id of the team named `name` that `userId` owns, created if missing. |
| `addMember({ teamId, userId, role?, by })` | Mutation. `by` needs `manageRole` or higher and can't grant a role above their own. |
| `setRole({ teamId, userId, role, by })` | Mutation. `by` needs `manageRole` or higher and must outrank the member, unless `by` is an owner. |
| `removeMember({ teamId, userId, by })` | Mutation. Same rules as `setRole`. |
| `leave({ teamId, userId })` | Mutation. Removes the user from the team. |
| `deleteTeam({ teamId, by })` | Mutation. Only an owner can delete a team; its members go with it. |
| `myTeams({ userId })` | Live query. `[{ teamId, name, role, createdAtMs }]` for every team the user is in. |
| `members({ teamId })` | Live query. `[{ userId, role, createdAtMs }]`, oldest first. |
| `role({ teamId, userId })` | Live query. The user's role, or `null` when they aren't a member. |

`assertRole(role, allowed)` is a plain function: it throws a `ConvexError` when `role` is `null` or not in `allowed`.

## Notes

- A team always keeps an owner: the last owner can't be demoted, removed or leave. Promote someone else first, or delete the team.
- A role that isn't in `roles` (after you rename one, say) ranks below every known role, so old rows lose power rather than gain it.
- Errors are `ConvexError`s with a message you can show the user, such as `Requires the admin role or higher.`
- Tables: `teams` and `members`. They're listed under the mount name on the dashboard's Data page.
