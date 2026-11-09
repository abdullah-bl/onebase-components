// Apple App Store billing as a onebase component. The server verifies Apple-signed
// documents itself (no third-party billing service): Server Notifications V2 arrive
// at the component's `/webhook` route, and the client posts StoreKit 2 transactions
// to `syncTransactions`. Both end in one internal mutation, `applyStoreEvent`, which
// keeps the subscription row idempotent and out-of-order safe:
//
//   * every event id is recorded once — replays are duplicates;
//   * a subscription bound to one account can't be claimed by another;
//   * a late notification never undoes a newer one (each carries Apple's signing time);
//   * SYNC (the app reporting what it sees) never undoes a newer state.
//
//   // onebase/components.ts
//   export default defineComponents({
//     store: appStore({ bundleId: "com.example.app", products: ["pro_monthly", "pro_yearly"] }),
//   });
//
// The webhook URL to register with App Store Server Notifications V2 is
// `https://<your-app>/store/webhook`.

import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "onebase/components";
import { OneBaseError, defineSchema, defineTable, type DataModelFromSchema } from "onebase/server";
import { v } from "onebase/values";
import { createStoreEvents, type NotificationResult, type StoreEvent, type StoreEvents, type StoreEventsConfig, type TransactionInfo } from "./apple/events";
import { AppleJwsError, base64Decode, verifyAppleJws } from "./apple/jws";

export { AppleJwsError, base64Decode, verifyAppleJws } from "./apple/jws";
export { createStoreEvents, notificationEventType } from "./apple/events";
export type { NotificationPayload, NotificationResult, StoreEvent, StoreEvents, StoreEventsConfig, TransactionInfo } from "./apple/events";

export type AppConfig = StoreEventsConfig & {
  /** Test override for the pinned root certificate (DER). */
  root?: Uint8Array;
  /** Test only: skip Apple's marker extension checks. */
  skipMarkers?: boolean;
};

const schema = defineSchema({
  subscriptions: defineTable({
    subject: v.string(),
    productId: v.string(),
    periodType: v.string(),
    status: v.string(),
    environment: v.string(),
    expiresAtMs: v.optional(v.number()),
    originalTransactionId: v.optional(v.string()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    lastEventId: v.optional(v.string()),
    lastEventAtMs: v.optional(v.number()),
    updatedAtMs: v.number(),
  })
    .index("by_subject", ["subject"])
    .index("by_orig", ["originalTransactionId"]),
  billing_events: defineTable({
    id: v.string(),
    type: v.string(),
    subject: v.optional(v.string()),
    recordedAtMs: v.number(),
  }).index("by_id", ["id"]),
});

const { internalMutation, mutation, query, httpAction } = componentServer<DataModelFromSchema<typeof schema>, AppConfig>();

const eventsFor = (config: AppConfig): StoreEvents =>
  createStoreEvents(config, { root: config.root, skipMarkers: config.skipMarkers });

const ACTIVE_STATUSES = ["trialing", "active", "past_due"];
const isActiveish = (status: string) => ACTIVE_STATUSES.includes(status);

const findSubscription = async (ctx: any, subject: string) =>
  ctx.db.query("subscriptions").withIndex("by_subject", (q: any) => q.eq("subject", subject)).unique();

const findActiveByOrig = async (ctx: any, orig: string) => {
  const rows = await ctx.db.query("subscriptions").withIndex("by_orig", (q: any) => q.eq("originalTransactionId", orig)).collect();
  return rows.find((row: any) => isActiveish(row.status as string)) ?? null;
};

const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** What an event type means for the subscription's status, or null when it changes nothing. */
function statusFor(type: string, periodType: unknown): string | null {
  if (type === "EXPIRATION") return "canceled";
  if (type === "REFUND") return "refunded";
  if (type === "BILLING_ISSUE") return "past_due";
  if (periodType === "TRIAL") return "trialing";
  if (["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE", "SUBSCRIPTION_EXTENDED", "SYNC"].includes(type)) {
    return "active";
  }
  return null;
}

/** One event, applied exactly once, in Apple's order. This is the port of `apply_store_event`. */
const applyStoreEvent = internalMutation({
  args: { event: v.any() },
  handler: async (ctx, { event }): Promise<Record<string, unknown>> => {
    const id = typeof event?.id === "string" ? event.id : null;
    const type = typeof event?.type === "string" ? event.type : null;
    if (!id || !type) throw new OneBaseError("invalid store event");

    const seen = await ctx.db.query("billing_events").withIndex("by_id", (q: any) => q.eq("id", id)).unique();
    if (seen) return { duplicate: true, eventId: id };
    await ctx.db.insert("billing_events", { id, type, recordedAtMs: Date.now() });

    const orig =
      typeof event.original_transaction_id === "string" && event.original_transaction_id !== ""
        ? event.original_transaction_id
        : null;
    let subject = typeof event.app_user_id === "string" && event.app_user_id !== "" ? event.app_user_id.toLowerCase() : "";
    // Renewals may not carry the account token; the original transaction finds the owner.
    const bound = orig ? await findActiveByOrig(ctx, orig) : null;
    if (!subject) subject = bound?.subject ?? "";
    if (!subject) return { ignored: true, reason: "no subject" };

    // One Apple subscription pays for one account.
    if (bound && bound.subject !== subject) {
      return { ignored: true, reason: "subscription belongs to another account" };
    }

    const current = await findSubscription(ctx, subject);
    const eventAtMs = numberOrNull(event.event_at_ms);
    const expiresAtMs = numberOrNull(event.expiration_at_ms);

    // A late event must not undo a newer one — SYNC included (ShaSha's `apply_store_event`
    // excluded SYNC here, which let a post-refund sync reactivate a refunded subscription).
    if (current && eventAtMs !== null && current.lastEventAtMs !== undefined && eventAtMs < current.lastEventAtMs) {
      return { ignored: true, reason: "stale event" };
    }
    // The app's own report only matters when it adds something we do not know.
    if (
      type === "SYNC" &&
      current &&
      current.originalTransactionId === orig &&
      isActiveish(current.status as string) &&
      current.productId === event.product_id &&
      (current.expiresAtMs ?? 0) >= (expiresAtMs ?? 0)
    ) {
      return { ignored: true, reason: "already up to date" };
    }

    if (type === "CANCELLATION") {
      if (current && isActiveish(current.status as string)) {
        await ctx.db.patch(current._id, {
          cancelAtPeriodEnd: true,
          lastEventAtMs: eventAtMs ?? current.lastEventAtMs,
          updatedAtMs: Date.now(),
        });
      }
      return { status: "cancel_scheduled" };
    }

    const status = statusFor(type, event.period_type);
    if (!status) return { ignored: true };

    const patch = {
      subject,
      productId: typeof event.product_id === "string" ? event.product_id : "",
      periodType: event.period_type === "TRIAL" ? "TRIAL" : "NORMAL",
      status,
      environment: event.environment === "PRODUCTION" ? "PRODUCTION" : "SANDBOX",
      expiresAtMs: expiresAtMs ?? current?.expiresAtMs,
      originalTransactionId: orig ?? current?.originalTransactionId,
      cancelAtPeriodEnd: status === "canceled" || status === "refunded",
      lastEventId: id,
      // SYNC is a report, not news: it doesn't advance the notification clock.
      lastEventAtMs: type === "SYNC" ? current?.lastEventAtMs : eventAtMs ?? current?.lastEventAtMs,
      updatedAtMs: Date.now(),
    };
    if (current) await ctx.db.patch(current._id, patch);
    else await ctx.db.insert("subscriptions", patch);
    return { status };
  },
});

const MAX_SYNC_TRANSACTIONS = 10;

/** Verifies StoreKit 2 transactions the client uploaded and records the longest active one. */
const syncTransactions = mutation({
  args: { userId: v.string(), signedTransactions: v.array(v.string()) },
  handler: async (ctx, { userId, signedTransactions }) => {
    if (signedTransactions.length === 0) throw new OneBaseError("No signed transactions.");
    if (signedTransactions.length > MAX_SYNC_TRANSACTIONS) throw new OneBaseError("Too many signed transactions.");
    const events = eventsFor(ctx.config);
    const now = Date.now();
    let best: { tx: TransactionInfo; expiresAtMs: number } | null = null;
    for (const jws of signedTransactions) {
      let tx: TransactionInfo;
      try {
        tx = await events.verifyTransaction(jws);
      } catch {
        throw new OneBaseError("A transaction failed verification.");
      }
      const token = typeof tx.appAccountToken === "string" ? tx.appAccountToken.toLowerCase() : "";
      if (token !== userId.toLowerCase()) throw new OneBaseError("A transaction belongs to another account.");
      if (!events.isUsableTransaction(tx)) continue;
      const expiresAtMs = typeof tx.expiresDate === "number" ? tx.expiresDate : 0;
      if (expiresAtMs <= now) continue;
      if (!best || expiresAtMs > best.expiresAtMs) best = { tx, expiresAtMs };
    }
    if (!best) throw new OneBaseError("No usable transactions.");
    return ctx.runMutation(applyStoreEvent, { event: events.syncEvent(best.tx) });
  },
});

/** The account's subscription state, or null; a live query. */
const getSubscription = query({
  args: { subject: v.string() },
  handler: async (ctx, { subject }) => {
    const row = await findSubscription(ctx, subject.toLowerCase());
    if (!row) return null;
    return {
      subject: row.subject as string,
      productId: row.productId as string,
      periodType: row.periodType as string,
      status: row.status as string,
      environment: row.environment as string,
      expiresAtMs: (row.expiresAtMs as number | undefined) ?? null,
      originalTransactionId: (row.originalTransactionId as string | undefined) ?? null,
      cancelAtPeriodEnd: (row.cancelAtPeriodEnd as boolean | undefined) ?? false,
      updatedAtMs: row.updatedAtMs as number,
    };
  },
});

/**
 * App Store Server Notifications V2. Apple signs every notification, so the
 * signature is the authentication: there is no shared secret. A bad signature is
 * 400, a type we don't act on is acknowledged with 200 so Apple stops retrying,
 * and a database failure is 500 so Apple retries.
 */
const webhook = httpAction(async (ctx, request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const signedPayload = (body as { signedPayload?: unknown } | null)?.signedPayload;
  if (typeof signedPayload !== "string") {
    return new Response(JSON.stringify({ error: "signedPayload required" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const events = eventsFor(ctx.config);
  let result: NotificationResult;
  try {
    result = await events.eventFromNotification(signedPayload);
  } catch {
    return new Response(JSON.stringify({ error: "verification failed" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (result.kind === "ignored") {
    return new Response(JSON.stringify({ ok: true, ignored: result.reason }), { status: 200, headers: { "content-type": "application/json" } });
  }
  try {
    const applied = await ctx.runMutation(applyStoreEvent, { event: result.event });
    return new Response(JSON.stringify({ ok: true, ...applied }), { status: 200, headers: { "content-type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ error: "could not store the event" }), { status: 500, headers: { "content-type": "application/json" } });
  }
});

export const definition = defineComponent({
  name: "app-store",
  schema,
  functions: { applyStoreEvent, syncTransactions, getSubscription },
  checkConfig: (config: AppConfig) => {
    if (typeof config?.bundleId !== "string" || config.bundleId.length === 0) {
      throw new Error("appStore({ bundleId }) needs the app's bundle id.");
    }
    if (!Array.isArray(config?.products) || config.products.length === 0 || config.products.some((p) => typeof p !== "string")) {
      throw new Error("appStore({ products }) needs the product ids the app sells.");
    }
  },
  http: () => [{ path: "/webhook", method: "POST", handler: webhook }],
});

// ---- Types for the app ----

export type SubscriptionView = {
  subject: string;
  productId: string;
  periodType: string;
  status: string;
  environment: string;
  expiresAtMs: number | null;
  originalTransactionId: string | null;
  cancelAtPeriodEnd: boolean;
  updatedAtMs: number;
};

export type AppStoreApi = {
  syncTransactions: ComponentFn<"mutation", (args: { userId: string; signedTransactions: string[] }) => Promise<Record<string, unknown>>>;
  getSubscription: ComponentFn<"query", (args: { subject: string }) => Promise<SubscriptionView | null>>;
};

/** Mounts app-store: `appStore({ bundleId, products })`. */
export function appStore<const E extends keyof AppStoreApi = never>(opts: AppConfig & MountOptions<E>): Mount<AppStoreApi, E> {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config, options) as unknown as Mount<AppStoreApi, E>;
}
