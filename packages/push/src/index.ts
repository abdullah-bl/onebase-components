// Push notifications: a device registry plus APNs and FCM routing. Devices are
// registered by the client (a token follows whoever signed in last — device
// tokens outlive accounts), sends go out from app actions, and dead tokens are
// forgotten the moment a provider reports them.
//
//   // onebase/components.ts
//   export default defineComponents({
//     push: push({
//       apns: { keyId, teamId, privateKey, topic: "com.example.app" },
//       fcm: fcmConfigFromJson(serviceAccountJson),
//     }),
//   });
//
//   // client (exposed)
//   api.components.push.register({ token, subject: userId, platform: "ios", environment: "production" });
//
//   // in an app action
//   await ctx.components.push.sendToUser({ subject: userId, payload: { title, body } });

import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "onebase/components";
import { OneBaseError, defineSchema, defineTable, type DataModelFromSchema } from "onebase/server";
import { v } from "onebase/values";
import { createApnsClient, type ApnsConfig, type ApnsEnvironment } from "./apns";
import { createFcmClient, type FcmConfig, type FcmMessage } from "./fcm";

export { apnsConfigFromEnv, createApnsClient } from "./apns";
export type { ApnsConfig, ApnsEnvironment, ApnsResult, ApnsSendOptions } from "./apns";
export { createFcmClient, fcmConfigFromJson } from "./fcm";
export type { FcmConfig, FcmMessage, FcmResult, FcmServiceAccount } from "./fcm";

export type PushConfig = {
  apns?: ApnsConfig;
  fcm?: FcmConfig;
};

export type PushPayload = {
  title?: string;
  body?: string;
  sound?: string;
  /** Custom keys delivered alongside the alert. */
  data?: Record<string, string>;
};

const schema = defineSchema({
  devices: defineTable({
    token: v.string(),
    subject: v.string(),
    platform: v.string(),
    environment: v.optional(v.string()),
    locale: v.optional(v.string()),
    createdAtMs: v.number(),
    lastSentAtMs: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_subject", ["subject"]),
});

const { action, internalMutation, mutation, query } = componentServer<DataModelFromSchema<typeof schema>, PushConfig>();

const findDevice = async (ctx: any, token: string) =>
  ctx.db.query("devices").withIndex("by_token", (q: any) => q.eq("token", token)).unique();

const register = mutation({
  args: {
    token: v.string(),
    subject: v.string(),
    platform: v.string(),
    environment: v.optional(v.string()),
    locale: v.optional(v.string()),
  },
  handler: async (ctx, { token, subject, platform, environment, locale }) => {
    if (token.length < 32 || token.length > 512) throw new OneBaseError("That does not look like a device token.");
    if (!["ios", "android", "web"].includes(platform)) throw new OneBaseError(`Unknown platform "${platform}".`);
    const row = await findDevice(ctx, token);
    const patch = { token, subject, platform, environment, locale, createdAtMs: row?.createdAtMs ?? Date.now() };
    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("devices", patch);
    return null;
  },
});

const unregister = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const row = await findDevice(ctx, token);
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

/** A subject's devices; a live query. */
const listDevices = query({
  args: { subject: v.string() },
  handler: async (ctx, { subject }) => {
    const rows = await ctx.db.query("devices").withIndex("by_subject", (q: any) => q.eq("subject", subject)).collect();
    return rows.map((row: any) => ({
      token: row.token as string,
      platform: row.platform as string,
      environment: (row.environment as string | undefined) ?? "production",
      locale: (row.locale as string | undefined) ?? null,
    }));
  },
});

const forget = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const row = await findDevice(ctx, token);
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

function apnsPayload(payload: PushPayload): object {
  return {
    aps: {
      ...(payload.title || payload.body ? { alert: { ...(payload.title ? { title: payload.title } : {}), ...(payload.body ? { body: payload.body } : {}) } } : {}),
      sound: payload.sound ?? "default",
    },
    ...(payload.data ?? {}),
  };
}

function fcmMessage(token: string, payload: PushPayload): FcmMessage {
  return {
    token,
    ...(payload.title || payload.body ? { notification: { ...(payload.title ? { title: payload.title } : {}), ...(payload.body ? { body: payload.body } : {}) } } : {}),
    ...(payload.data ? { data: payload.data } : {}),
  };
}

const MAX_SUBJECTS = 100;

/** Sends to every device of one subject, routing by platform, forgetting dead tokens. */
const sendToUser = action({
  args: { subject: v.string(), payload: v.any() },
  handler: async (ctx, { subject, payload }) => {
    const config = ctx.config as PushConfig;
    const apns = config.apns ? createApnsClient(config.apns) : null;
    const fcm = config.fcm ? createFcmClient(config.fcm) : null;
    if (!apns && !fcm) throw new OneBaseError("No push provider configured.");
    const rows = await ctx.runQuery(listDevices, { subject });
    let sent = 0;
    const failures: { token: string; reason: string }[] = [];
    for (const device of rows as { token: string; platform: string; environment: string }[]) {
      const result =
        device.platform === "ios"
          ? apns
            ? await apns.send(device.token, (device.environment as ApnsEnvironment) ?? "production", apnsPayload(payload))
            : { ok: false as const, status: 0, reason: "no apns configured", dead: false }
          : fcm
            ? await fcm.send(fcmMessage(device.token, payload))
            : { ok: false as const, status: 0, reason: "no fcm configured", dead: false };
      if (result.ok) {
        sent++;
        continue;
      }
      if (result.dead) await ctx.runMutation(forget, { token: device.token });
      failures.push({ token: device.token, reason: result.reason });
    }
    return { sent, failures };
  },
});

/** Sends to many subjects at once; at most 100 per call. */
const sendToUsers = action({
  args: { subjects: v.array(v.string()), payload: v.any() },
  handler: async (ctx, { subjects, payload }) => {
    if (subjects.length > MAX_SUBJECTS) throw new OneBaseError(`At most ${MAX_SUBJECTS} subjects per call.`);
    let sent = 0;
    const failures: { token: string; reason: string }[] = [];
    for (const subject of new Set(subjects)) {
      const result = (await ctx.runAction(sendToUser, { subject, payload })) as { sent: number; failures: { token: string; reason: string }[] };
      sent += result.sent;
      failures.push(...result.failures);
    }
    return { sent, failures };
  },
});

export const definition = defineComponent({
  name: "push",
  schema,
  functions: { register, unregister, listDevices, sendToUser, sendToUsers, forget },
  checkConfig: (config: PushConfig) => {
    if (!config?.apns && !config?.fcm) throw new Error("push() needs at least one of apns or fcm credentials.");
  },
});

// ---- Types for the app ----

export type DeviceView = { token: string; platform: string; environment: string; locale: string | null };
export type SendReport = { sent: number; failures: { token: string; reason: string }[] };

export type PushApi = {
  register: ComponentFn<"mutation", (args: { token: string; subject: string; platform: string; environment?: string; locale?: string }) => Promise<null>>;
  unregister: ComponentFn<"mutation", (args: { token: string }) => Promise<null>>;
  listDevices: ComponentFn<"query", (args: { subject: string }) => Promise<DeviceView[]>>;
  sendToUser: ComponentFn<"action", (args: { subject: string; payload: PushPayload }) => Promise<SendReport>>;
  sendToUsers: ComponentFn<"action", (args: { subjects: string[]; payload: PushPayload }) => Promise<SendReport>>;
};

/** Mounts push: `push({ apns: {...}, fcm: fcmConfigFromJson(json) })`. */
export function push<const E extends keyof PushApi = never>(opts: PushConfig & MountOptions<E>): Mount<PushApi, E> {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config, options) as unknown as Mount<PushApi, E>;
}
