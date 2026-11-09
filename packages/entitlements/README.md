# @onebase/entitlements

Plans, limits and usage. Each subject (a user id or a team id, whatever your app bills) has at most one plan. A plan sets limits, and the component counts usage against them, so a mutation can ask "may this team add another screen?" in the same transaction that adds it. Usage counters can reset each period; they roll over when next touched, so no cron has to run on time.

## Install

```bash
bun add @onebase/entitlements
```

Until the package is on npm, depend on a checkout of this repository instead: `bun add @onebase/entitlements@file:../onebase-components/packages/entitlements`.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { entitlements } from "@onebase/entitlements";

export default defineComponents({
  ent: entitlements({
    plans: {
      free: { limits: { screens: 3, bytes: 1_000_000_000 } },
      pro: { limits: { screens: 100, bytes: 50_000_000_000 }, periodDays: 30 },
    },
    // App Store product id → plan, for applyStoreEvent.
    productPlans: { pro_monthly: "pro", pro_yearly: "pro" },
  }),
});
```

Each plan's `limits` maps a limit name to a cap, a finite number of zero or more. With `periodDays`, usage resets that many days after the period started; without it, usage only grows (a total, such as screens owned).

## Use it

```ts
// onebase/screens.ts
import { ConvexError, mutation } from "onebase/server";
import { v } from "onebase/values";

export const add = mutation({
  args: { teamId: v.string(), name: v.string() },
  handler: async (ctx, { teamId, name }) => {
    const gate = await ctx.components.ent.increment({ subject: teamId, limit: "screens" });
    if (!gate.allowed) throw new ConvexError("Upgrade to add more screens.");
    await ctx.db.insert("screens", { teamId, name });
  },
});
```

`increment` only counts what it allows: a refused request uses nothing. If the rest of your mutation throws, the count is rolled back with it.

Give subjects a plan with `setPlan`, from your own sign-up, admin or billing code:

```ts
await ctx.components.ent.setPlan({ subject: teamId, plan: "free" });
await ctx.components.ent.setPlan({ subject: teamId, plan: "pro", expiresAtMs: Date.now() + 30 * 86_400_000 });
```

A subject with no plan, or whose plan has expired, is allowed nothing. To show a usage meter, read `check` from a live query; it reports without counting.

## From the App Store

`applyStoreEvent({ event })` takes the store events [`@onebase/app-store`](../app-store) produces. Nothing connects the two components on its own: hand it the events your billing code sees, such as those from `createStoreEvents(...).eventFromNotification` in a webhook route of your own. Purchases, renewals and syncs of a product in `productPlans` assign that plan until the event's expiry; refunds and expirations remove it. The event's shape is all that matters, so a Stripe webhook or an admin tool can drive it too.

It applies each event as it comes: unlike `@onebase/app-store`, it doesn't drop duplicates or events that arrive out of order, so feed it events in order.

## Functions

| | |
|---|---|
| `setPlan({ subject, plan, expiresAtMs? })` | Mutation. Assigns a plan, replacing the current one. |
| `revoke({ subject })` | Mutation. Removes the subject's plan. |
| `getPlan({ subject })` | Live query. `{ subject, plan, limits, periodDays }` for the plan in force, or `null`. |
| `check({ subject, limit, by? })` | Live query. `{ allowed, used, remaining, plan }`: whether `by` more (default 1) would fit, without counting it. |
| `increment({ subject, limit, by? })` | Mutation. Counts `by` (default 1) when it fits, and returns the same shape as `check`, as it was before counting. |
| `applyStoreEvent({ event })` | Mutation. Assigns or removes a plan from a store event. Returns `{ plan }`, `{ status: "expired" }` or `{ ignored: true }`. |

The package also exports the limit math as plain functions: `canAdd(used, by, cap)`, `remaining(used, cap)` and `periodExpired(periodStartMs, now, periodDays?)`.

## Notes

- A limit a plan doesn't name is not allowed at all, so add new limits to every plan that should have them.
- Changing a plan keeps the usage already counted; `revoke` keeps it too.
- An App Store refund or expiry removes only a plan that came from the App Store, never one you set with `setPlan`.
- Subjects from store events are lowercased.
- Tables: `assignments` and `usage`. They're listed under the mount name on the dashboard's Data page.
