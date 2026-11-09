# @onebase/app-store

Apple App Store subscriptions, checked by your own server. Apple signs everything it sends, and this component verifies those signatures itself against Apple's root certificate, so there's no billing service in between. It keeps one subscription row per account, fed from two sides:

- **App Store Server Notifications V2**, which Apple posts to the component's `/webhook` route.
- **StoreKit 2 transactions**, which your app uploads with `syncTransactions` after a purchase or a restore.

Both go through one internal mutation that applies each event once and in Apple's order:

- every event id is recorded, so a replay is a no-op;
- a subscription bound to one account can't be claimed by another;
- a late notification never undoes a newer one, since each carries the time Apple signed it;
- a sync from the app never undoes a newer state.

## Install

```bash
bun add @onebase/app-store
```

Until the package is on npm, depend on a checkout of this repository instead: `bun add @onebase/app-store@file:../onebase-components/packages/app-store`.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { appStore } from "@onebase/app-store";

export default defineComponents({
  store: appStore({ bundleId: "com.example.app", products: ["pro_monthly", "pro_yearly"] }),
});
```

`bundleId` is your app's bundle id, and `products` the subscription product ids it sells. Transactions and notifications for another app or an unknown product are ignored.

Then, in App Store Connect, set the **App Store Server Notifications** URL (Version 2) for production and sandbox to:

```
https://<your-server>/store/webhook
```

The path starts with the mount name, `store` here. Mount with `httpPrefix: "/billing"` to serve it at `/billing/webhook` instead.

## Use it

In the app, make every purchase with an `appAccountToken`: a UUID that stands for the account in your backend. That token is how the component knows whose subscription a transaction is. Notifications are filed under it, `syncTransactions` refuses a transaction whose token isn't the `userId` it's given, and `getSubscription` looks it up as `subject`. If your user ids aren't UUIDs, keep a UUID per user and use that everywhere below.

After a purchase or a restore, send the signed transactions (`Transaction.currentEntitlements` in StoreKit 2, each one's `jwsRepresentation`) to your backend:

```ts
// onebase/billing.ts
import { mutation, query, getAuthUserId } from "onebase/server";
import { v } from "onebase/values";

export const sync = mutation({
  args: { signedTransactions: v.array(v.string()) },
  handler: async (ctx, { signedTransactions }) => {
    const me = await getAuthUserId(ctx); // here the user id is the UUID the app sets as appAccountToken
    if (!me) throw new Error("Sign in first.");
    return ctx.components.store.syncTransactions({ userId: me, signedTransactions });
  },
});

export const subscription = query({
  args: {},
  handler: async (ctx) => {
    const me = await getAuthUserId(ctx);
    return me ? ctx.components.store.getSubscription({ subject: me }) : null;
  },
});
```

`getSubscription` is a live query, so the app sees a renewal, a cancellation or a refund as soon as Apple's notification lands.

## Functions

| | |
|---|---|
| `syncTransactions({ userId, signedTransactions })` | Mutation. Verifies up to 10 signed transactions, keeps the usable one that expires last, and applies it as a `SYNC` event. Throws if any fails verification or belongs to another account, or if none is usable. |
| `getSubscription({ subject })` | Live query. `{ subject, productId, periodType, status, environment, expiresAtMs, originalTransactionId, cancelAtPeriodEnd, updatedAtMs }`, or `null`. |
| `POST /webhook` | HTTP route for Apple's notifications. A bad signature gets 400, a notification it doesn't act on gets 200 so Apple stops retrying, and a database failure gets 500 so Apple retries. |

`status` is one of `trialing`, `active`, `past_due` (billing retry), `canceled` (expired) or `refunded`. `cancelAtPeriodEnd` is true once the user has turned off auto-renew; the subscription stays active until `expiresAtMs`.

## Driving other components

The package also exports what the component uses inside, for your own routes and checks:

- `createStoreEvents({ bundleId, products })` returns `verifyTransaction`, `isUsableTransaction`, `syncEvent` and `eventFromNotification`, which turn Apple's signed payloads into plain `StoreEvent` objects.
- `verifyAppleJws(jws)` verifies any Apple-signed JWS and returns its payload.
- `notificationEventType(type, subtype)` maps a notification type to the event type it becomes.

A `StoreEvent` is the shape [`@onebase/entitlements`](../entitlements) takes in its `applyStoreEvent`, so you can turn App Store subscriptions into plans and limits.

## Notes

- Ids are compared in lowercase: `appAccountToken` UUIDs from StoreKit are lowercased before they're stored or matched.
- Renewal notifications may arrive without an `appAccountToken`; the component finds the account through the original transaction id.
- Tables: `subscriptions` and `billing_events`. They're listed under the mount name on the dashboard's Data page.
