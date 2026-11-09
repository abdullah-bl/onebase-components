// Entitlements: assignment lifecycle, usage gates with lazy period rollover, and
// store-event application. Time is controlled with setSystemTime.

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { defineComponents } from "onebase/components";
import { defineSchema } from "onebase/server";
import { entitlements } from "../src/index";
import { call, callMutation, openRuntime, type TestApp } from "../../../test/app";

// Restore the real clock so a frozen time doesn't leak into other test files.
afterEach(() => setSystemTime());

const appSchema = defineSchema({});

const config = {
  plans: {
    free: { limits: { screens: 3, bytes: 1_000 } },
    pro: { limits: { screens: 100, bytes: 50_000 }, periodDays: 30 },
  },
  productPlans: { pro_monthly: "pro", basic_monthly: "free" },
  expose: ["setPlan", "revoke", "getPlan", "check", "increment", "applyStoreEvent"] as const,
};

const components = () => defineComponents({ ent: entitlements(config) as any });

async function open() {
  return openRuntime({ schema: appSchema, modules: {}, components: components() });
}

const getPlan = (app: TestApp, subject: string) => call(app, "ent:getPlan", { subject }).then((r) => r.value);
const check = (app: TestApp, subject: string, limit: string, by?: number) =>
  call(app, "ent:check", by === undefined ? { subject, limit } : { subject, limit, by }).then((r) => r.value);
const increment = (app: TestApp, subject: string, limit: string, by?: number) =>
  callMutation(app, "ent:increment", by === undefined ? { subject, limit } : { subject, limit, by });
const usage = (app: TestApp, subject: string) =>
  app.runtime.runQuery("components/ent:usageFor", { subject }, { allowInternal: true, source: "dashboard" }).then((r) => r.value);

describe("entitlements", () => {
  test("setPlan, getPlan, and revoke", async () => {
    const app = await open();
    try {
      expect(await getPlan(app, "t1")).toBeNull();
      await callMutation(app, "ent:setPlan", { subject: "t1", plan: "free" });
      expect(await getPlan(app, "t1")).toMatchObject({ plan: "free", limits: { screens: 3, bytes: 1_000 }, periodDays: null });
      await callMutation(app, "ent:revoke", { subject: "t1" });
      expect(await getPlan(app, "t1")).toBeNull();
      await expect(callMutation(app, "ent:setPlan", { subject: "t1", plan: "gold" })).rejects.toThrow('Unknown plan "gold"');
    } finally {
      await app.close();
    }
  });

  test("expired assignments entitle nothing", async () => {
    const app = await open();
    try {
      setSystemTime(Date.UTC(2026, 0, 1));
      await callMutation(app, "ent:setPlan", { subject: "t1", plan: "free", expiresAtMs: Date.now() + 1_000 });
      expect(await getPlan(app, "t1")).toMatchObject({ plan: "free" });
      setSystemTime(Date.now() + 2_000);
      expect(await getPlan(app, "t1")).toBeNull();
      expect(await check(app, "t1", "screens")).toMatchObject({ allowed: false, plan: null });
    } finally {
      await app.close();
    }
  });

  test("increment gates use and refuses politely", async () => {
    const app = await open();
    try {
      await callMutation(app, "ent:setPlan", { subject: "t1", plan: "free" });
      expect(await increment(app, "t1", "screens")).toMatchObject({ allowed: true, used: 0, remaining: 3 });
      await increment(app, "t1", "screens");
      await increment(app, "t1", "screens");
      const refused = await increment(app, "t1", "screens");
      expect(refused).toMatchObject({ allowed: false, used: 3, remaining: 0 });
      // A refused request consumed nothing.
      expect(await usage(app, "t1")).toEqual([{ limit: "screens", used: 3, periodStartMs: expect.any(Number) }]);
      expect(await check(app, "t1", "screens", 2)).toMatchObject({ allowed: false });
    } finally {
      await app.close();
    }
  });

  test("limits not in the plan entitle nothing", async () => {
    const app = await open();
    try {
      await callMutation(app, "ent:setPlan", { subject: "t1", plan: "free" });
      expect(await check(app, "t1", "ai_credits")).toMatchObject({ allowed: false, remaining: 0 });
    } finally {
      await app.close();
    }
  });

  test("periods roll over lazily", async () => {
    const app = await open();
    try {
      setSystemTime(Date.UTC(2026, 0, 1));
      await callMutation(app, "ent:setPlan", { subject: "t1", plan: "pro" });
      await increment(app, "t1", "screens", 50);
      expect(await check(app, "t1", "screens")).toMatchObject({ used: 50, remaining: 50 });
      // 31 days later the period has rolled over.
      setSystemTime(Date.UTC(2026, 1, 1));
      expect(await check(app, "t1", "screens")).toMatchObject({ used: 0, remaining: 100 });
      // The lifetime limit on free never rolls.
      await callMutation(app, "ent:setPlan", { subject: "t2", plan: "free" });
      setSystemTime(Date.UTC(2027, 5, 1));
      await increment(app, "t2", "screens");
      expect(await usage(app, "t2")).toEqual([{ limit: "screens", used: 1, periodStartMs: expect.any(Number) }]);
    } finally {
      await app.close();
    }
  });

  test("store events drive assignments", async () => {
    const app = await open();
    try {
      const event = {
        id: "uuid-1",
        type: "INITIAL_PURCHASE",
        app_user_id: "U1",
        product_id: "pro_monthly",
        expiration_at_ms: Date.now() + 30 * 86_400_000,
      };
      expect(await callMutation(app, "ent:applyStoreEvent", { event })).toMatchObject({ plan: "pro" });
      expect(await getPlan(app, "u1")).toMatchObject({ plan: "pro" });

      expect(
        await callMutation(app, "ent:applyStoreEvent", { event: { ...event, id: "uuid-2", product_id: "unknown_product" } }),
      ).toMatchObject({ ignored: true });
      expect(
        await callMutation(app, "ent:applyStoreEvent", { event: { ...event, id: "uuid-3", app_user_id: null } }),
      ).toMatchObject({ ignored: true });

      expect(await callMutation(app, "ent:applyStoreEvent", { event: { ...event, id: "uuid-4", type: "REFUND" } })).toMatchObject({
        status: "expired",
      });
      expect(await getPlan(app, "u1")).toBeNull();

      // A manual assignment is never touched by store events.
      await callMutation(app, "ent:setPlan", { subject: "u1", plan: "free" });
      expect(await callMutation(app, "ent:applyStoreEvent", { event: { ...event, id: "uuid-5", type: "EXPIRATION" } })).toMatchObject({
        status: "expired",
      });
      expect(await getPlan(app, "u1")).toMatchObject({ plan: "free" });
    } finally {
      await app.close();
    }
  });
});
