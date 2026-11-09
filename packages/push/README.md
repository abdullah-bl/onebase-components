# @onebase/push

Push notifications to iOS and Android. Apps register their device tokens, your backend sends to a user, and the component routes each device to Apple Push Notification service (APNs) for iOS or Firebase Cloud Messaging (FCM) for Android and web. A token that the provider reports as dead is forgotten on the spot. Both clients use only `fetch` and WebCrypto, with no SDKs.

## Install

```bash
bun add @onebase/push
```

Until the package is on npm, depend on a checkout of this repository instead: `bun add @onebase/push@file:../onebase-components/packages/push`.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { push, apnsConfigFromEnv, fcmConfigFromJson } from "@onebase/push";

export default defineComponents({
  push: push({
    apns: apnsConfigFromEnv() ?? undefined,
    fcm: process.env.FCM_SERVICE_ACCOUNT ? fcmConfigFromJson(process.env.FCM_SERVICE_ACCOUNT) : undefined,
  }),
});
```

Configure at least one provider:

- **APNs:** `{ keyId, teamId, privateKey, topic }`, where `privateKey` is the contents of the `AuthKey_XXXX.p8` file from your Apple developer account and `topic` is the app's bundle id. `apnsConfigFromEnv()` reads them from `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` and `APNS_TOPIC`, turns literal `\n` in the key into line breaks, and returns `null` when the first three aren't set.
- **FCM:** `{ credentials, projectId? }`, where `credentials` is a Firebase service account. `fcmConfigFromJson(json)` parses the downloaded service-account JSON file; the project id comes from it.

## Use it

Register the device from the app once it has a token, and again whenever the token changes or another user signs in:

```ts
// onebase/devices.ts
import { mutation, getAuthUserId } from "onebase/server";
import { v } from "onebase/values";

export const register = mutation({
  args: { token: v.string(), platform: v.string(), environment: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await getAuthUserId(ctx);
    if (!me) throw new Error("Sign in first.");
    await ctx.components.push.register({ ...args, subject: me });
  },
});
```

`platform` is `ios`, `android` or `web`. For iOS, pass `environment: "sandbox"` from development builds; it defaults to `production`. A token belongs to whoever registered it last, since a phone outlives the accounts signed in on it.

Send from an action:

```ts
// onebase/alerts.ts
import { internalAction } from "onebase/server";
import { v } from "onebase/values";

export const notify = internalAction({
  args: { userId: v.string(), title: v.string(), body: v.string() },
  handler: async (ctx, { userId, title, body }) => {
    const report = await ctx.components.push.sendToUser({ subject: userId, payload: { title, body, data: { screen: "alerts" } } });
    // { sent: 2, failures: [{ token, reason }] }
  },
});
```

To send from a mutation, schedule an action like this one with `ctx.scheduler.runAfter(0, internal.alerts.notify, args)`.

Don't `expose` `register` to clients as it is: it trusts the `subject` it's given, so a client could register its phone to receive someone else's notifications. Wrap it as above.

## Functions

| | |
|---|---|
| `register({ token, subject, platform, environment?, locale? })` | Mutation. Adds the device, or moves it to `subject` if it's already known. |
| `unregister({ token })` | Mutation. Forgets the device, for sign-out. |
| `listDevices({ subject })` | Live query. `[{ token, platform, environment, locale }]`. |
| `sendToUser({ subject, payload })` | Action. Sends to each of the subject's devices and returns `{ sent, failures }`. |
| `sendToUsers({ subjects, payload })` | Action. The same for up to 100 subjects, with one combined report. |

A payload is `{ title?, body?, sound?, data? }`. `data` is a map of strings, delivered alongside the alert: as top-level keys on iOS, as FCM `data` on Android and web. iOS plays the default sound unless you pass `sound`.

## Notes

- A device whose provider isn't configured shows up in `failures` (for example `no apns configured`) and is kept.
- Dead tokens: APNs `410`, `404`, `BadDeviceToken` or `DeviceTokenNotForTopic`; FCM `404`, `410` or an unregistered or invalid token.
- `createApnsClient` and `createFcmClient` are exported too, for sending without the device registry.
- Table: `devices`. It's listed under the mount name on the dashboard's Data page.
