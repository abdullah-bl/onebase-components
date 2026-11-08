// Plans, limits, and usage. A subject — a user id or a team id, whatever the app
// bills — holds one plan assignment; usage counters roll over lazily on touch, so
// a period can never be missed by a sleeping cron.
//
//   // onebase/components.ts
//   export default defineComponents({
//     ent: entitlements({
//       plans: {
//         free: { limits: { screens: 3, bytes: 1_000_000_000 } },
//         pro: { limits: { screens: 100, bytes: 50_000_000_000 }, periodDays: 30 },
//       },
//       productPlans: { pro_monthly: "pro", pro_yearly: "pro" },
//     }),
//   });
//
//   // in an app mutation
//   const gate = await ctx.components.ent.increment({ subject: teamId, limit: "screens" });
//   if (!gate.allowed) throw new ConvexError("Upgrade to add more screens.");
//
// Store events (`applyStoreEvent`) take the same shape `@onebase/app-store`
// produces, but nothing imports it: the shape is structural, so any billing
// source — App Store, Stripe, an admin console — can drive assignments.

import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "onebase/components";
import { ConvexError, defineSchema, defineTable, type DataModelFromSchema } from "onebase/server";
import { v } from "onebase/values";
import { canAdd, periodExpired, remaining } from "./limits";

export { canAdd, periodExpired, remaining } from "./limits";

export type PlanLimits = Record<string, number>;

export type EntitlementsConfig = {
  /** Plan definitions; `limits` values must be finite and non-negative. */
  plans: Record<string, { limits: PlanLimits; periodDays?: number }>;
  /** Store product id → plan name, for `applyStoreEvent`. */
  productPlans?: Record<string, string>;
};

/** The one field set `applyStoreEvent` needs; structurally a `@onebase/app-store` StoreEvent. */
export type StoreEventLike = {
  id: string;
  type: string;
  app_user_id: string | null;
  product_id: string;
  expiration_at_ms: number | null;
};

const schema = defineSchema({
  assignments: defineTable({
    subject: v.string(),
    plan: v.string(),
    status: v.string(),
    source: v.string(),
    expiresAtMs: v.optional(v.number()),
    updatedAtMs: v.number(),
  }).index("by_subject", ["subject"]),
  usage: defineTable({
    subject: v.string(),
    limit: v.string(),
    used: v.number(),
    periodStartMs: v.number(),
  }).index("by_subject_limit", ["subject", "limit"]),
});

const { internalQuery, mutation, query } = componentServer<DataModelFromSchema<typeof schema>, EntitlementsConfig>();

const findAssignment = async (ctx: any, subject: string) =>
  ctx.db.query("assignments").withIndex("by_subject", (q: any) => q.eq("subject", subject)).unique();

const findUsage = async (ctx: any, subject: string, limit: string) =>
  ctx.db.query("usage").withIndex("by_subject_limit", (q: any) => q.eq("subject", subject).eq("limit", limit)).unique();

/** The plan that is in force right now, or null. Expiry is computed, never trusted from storage. */
async function effectivePlan(ctx: any, subject: string): Promise<{ plan: string; limits: PlanLimits; periodDays?: number } | null> {
  const row = await findAssignment(ctx, subject);
  if (!row || row.status !== "active") return null;
  if (row.expiresAtMs !== undefined && row.expiresAtMs <= Date.now()) return null;
  const def = ctx.config.plans[row.plan];
  if (!def) return null;
  return { plan: row.plan as string, limits: def.limits as PlanLimits, periodDays: def.periodDays };
}

/** The usage row, with its period rolled over when due. Queries compute the rollover; mutations persist it. */
async function rolledUsage(ctx: any, subject: string, limit: string, periodDays?: number, canWrite = true) {
  const now = Date.now();
  let row = await findUsage(ctx, subject, limit);
  if (row && periodExpired(row.periodStartMs as number, now, periodDays)) {
    if (canWrite) await ctx.db.patch(row._id, { used: 0, periodStartMs: now });
    row = { ...row, used: 0, periodStartMs: now };
  }
  return { row, now };
}

async function limitFor(ctx: any, subject: string, limit: string, by: number, canWrite: boolean) {
  const active = await effectivePlan(ctx, subject);
  if (!active) return { allowed: false, used: 0, remaining: 0, plan: null as string | null, periodDays: undefined as number | undefined, cap: 0 };
  const cap = active.limits[limit];
  if (typeof cap !== "number") return { allowed: false, used: 0, remaining: 0, plan: active.plan, periodDays: active.periodDays, cap: 0 };
  const { row } = await rolledUsage(ctx, subject, limit, active.periodDays, canWrite);
  const used = (row?.used as number | undefined) ?? 0;
  return { allowed: canAdd(used, by, cap), used, remaining: remaining(used, cap), plan: active.plan, periodDays: active.periodDays, cap };
}

const setPlan = mutation({
  args: { subject: v.string(), plan: v.string(), expiresAtMs: v.optional(v.number()) },
  handler: async (ctx, { subject, plan, expiresAtMs }) => {
    if (!ctx.config.plans[plan]) throw new ConvexError(`Unknown plan "${plan}".`);
    const row = await findAssignment(ctx, subject);
    const patch = { subject, plan, status: "active", source: "manual", expiresAtMs, updatedAtMs: Date.now() };
    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("assignments", patch);
    return null;
  },
});

const revoke = mutation({
  args: { subject: v.string() },
  handler: async (ctx, { subject }) => {
    const row = await findAssignment(ctx, subject);
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

/** The subject's plan and its limit caps; a live query. */
const getPlan = query({
  args: { subject: v.string() },
  handler: async (ctx, { subject }) => {
    const active = await effectivePlan(ctx, subject);
    if (!active) return null;
    return { subject, plan: active.plan, limits: active.limits, periodDays: active.periodDays ?? null };
  },
});

/** Where the subject stands against one limit; a live query. */
const check = query({
  args: { subject: v.string(), limit: v.string(), by: v.optional(v.number()) },
  handler: async (ctx, { subject, limit, by = 1 }) => {
    const state = await limitFor(ctx, subject, limit, by, false);
    return { allowed: state.allowed, used: state.used, remaining: state.remaining, plan: state.plan };
  },
});

/**
 * Consumes `by` of a limit and says whether it fits. A refused request consumes
 * nothing. Returns the gate; the app decides whether that is an error.
 */
const increment = mutation({
  args: { subject: v.string(), limit: v.string(), by: v.optional(v.number()) },
  handler: async (ctx, { subject, limit, by = 1 }) => {
    if (by < 0) throw new ConvexError("by must be zero or positive.");
    const state = await limitFor(ctx, subject, limit, by, true);
    if (state.allowed && state.cap > 0) {
      const row = await findUsage(ctx, subject, limit);
      const patch = { subject, limit, used: state.used + by, periodStartMs: state.periodDays !== undefined ? (row?.periodStartMs as number | undefined) ?? Date.now() : Date.now() };
      if (row) await ctx.db.patch(row._id, patch);
      else await ctx.db.insert("usage", patch);
    }
    return { allowed: state.allowed, used: state.used, remaining: state.remaining, plan: state.plan };
  },
});

/**
 * Applies a store event (the shape `@onebase/app-store` produces). Only events
 * for a known product with a subject change anything; REFUND and EXPIRATION
 * remove an app-store-sourced assignment but never a manual one.
 */
const applyStoreEvent = mutation({
  args: { event: v.any() },
  handler: async (ctx, { event }) => {
    const plan = ctx.config.productPlans?.[event?.product_id];
    const subject = typeof event?.app_user_id === "string" && event.app_user_id !== "" ? event.app_user_id.toLowerCase() : null;
    const type = typeof event?.type === "string" ? event.type : null;
    if (!plan || !subject || !type) return { ignored: true };
    if (!ctx.config.plans[plan]) return { ignored: true };

    const row = await findAssignment(ctx, subject);
    if (type === "REFUND" || type === "EXPIRATION") {
      if (row && row.source === "app-store") await ctx.db.delete(row._id);
      return { status: "expired" };
    }
    if (!["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE", "SUBSCRIPTION_EXTENDED", "SYNC", "BILLING_ISSUE"].includes(type)) {
      return { ignored: true };
    }

    const expiresAtMs = typeof event.expiration_at_ms === "number" ? event.expiration_at_ms : undefined;
    const patch = { subject, plan, status: "active", source: "app-store", expiresAtMs, updatedAtMs: Date.now() };
    if (row) await ctx.db.patch(row._id, patch);
    else await ctx.db.insert("assignments", patch);
    return { plan };
  },
});

/** Usage rows for a subject — internal, for diagnostics and tests. */
const usageFor = internalQuery({
  args: { subject: v.string() },
  handler: async (ctx, { subject }) => {
    const rows = await ctx.db.query("usage").withIndex("by_subject_limit", (q: any) => q.eq("subject", subject)).collect();
    return rows.map((row: any) => ({ limit: row.limit as string, used: row.used as number, periodStartMs: row.periodStartMs as number }));
  },
});

export const definition = defineComponent({
  name: "entitlements",
  schema,
  functions: { setPlan, revoke, getPlan, check, increment, applyStoreEvent, usageFor },
  checkConfig: (config: EntitlementsConfig) => {
    const plans = config?.plans;
    if (!plans || typeof plans !== "object" || Object.keys(plans).length === 0) {
      throw new Error("entitlements({ plans }) needs at least one plan.");
    }
    for (const [name, def] of Object.entries(plans)) {
      for (const [limit, cap] of Object.entries((def as { limits: PlanLimits }).limits ?? {})) {
        if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) {
          throw new Error(`entitlements plan "${name}" limit "${limit}" must be a finite, non-negative number.`);
        }
      }
    }
  },
});

// ---- Types for the app ----

export type PlanView = { subject: string; plan: string; limits: PlanLimits; periodDays: number | null };
export type Gate = { allowed: boolean; used: number; remaining: number; plan: string | null };

export type EntitlementsApi<P extends string = string, L extends string = string> = {
  setPlan: ComponentFn<"mutation", (args: { subject: string; plan: P; expiresAtMs?: number }) => Promise<null>>;
  revoke: ComponentFn<"mutation", (args: { subject: string }) => Promise<null>>;
  getPlan: ComponentFn<"query", (args: { subject: string }) => Promise<PlanView | null>>;
  check: ComponentFn<"query", (args: { subject: string; limit: L; by?: number }) => Promise<Gate>>;
  increment: ComponentFn<"mutation", (args: { subject: string; limit: L; by?: number }) => Promise<Gate>>;
  applyStoreEvent: ComponentFn<"mutation", (args: { event: StoreEventLike }) => Promise<Record<string, unknown>>>;
};

/** Mounts entitlements: `entitlements({ plans: {...}, productPlans: {...} })`. */
export function entitlements<const P extends string, const L extends string, const E extends keyof EntitlementsApi<P, L> = never>(
  opts: EntitlementsConfig & MountOptions<E>,
): Mount<EntitlementsApi<P, L>, E> {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config, options) as unknown as Mount<EntitlementsApi<P, L>, E>;
}
