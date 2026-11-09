// pruneEvents: forgets processed-event ids recorded before a cutoff, a batch at a time.

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { defineComponents } from "onebase/components";
import { defineSchema } from "onebase/server";
import { appStore, type StoreEvent } from "../src/index";
import { callMutation, openRuntime, type TestApp } from "../../../test/app";

// Restore the real clock so a frozen time doesn't leak into other test files.
afterEach(() => setSystemTime());

const USER = "11111111-1111-4111-8111-111111111111";
const DAY = 86_400_000;

const open = () =>
  openRuntime({
    schema: defineSchema({}),
    modules: {},
    components: defineComponents({
      store: appStore({ bundleId: "com.test.app", products: ["pro_monthly"], expose: ["pruneEvents"] as const }) as any,
    }),
  });

const apply = (app: TestApp, id: string) => {
  const event: StoreEvent = {
    id,
    type: "RENEWAL",
    app_user_id: USER,
    product_id: "pro_monthly",
    period_type: "NORMAL",
    expiration_at_ms: Date.now() + 30 * DAY,
    original_transaction_id: "1000000000001",
    transaction_id: null,
    environment: "SANDBOX",
    event_at_ms: Date.now(),
  };
  return app.runtime.runMutation("components/store:applyStoreEvent", { event }, { allowInternal: true, source: "dashboard" }) as Promise<
    Record<string, unknown>
  >;
};

const prune = (app: TestApp, args: { beforeMs: number; limit?: number }) =>
  callMutation(app, "store:pruneEvents", args) as Promise<{ deleted: number }>;

describe("pruneEvents", () => {
  test("deletes only events recorded before the cutoff, at most `limit` per call", async () => {
    const app = await open();
    try {
      const start = Date.UTC(2026, 0, 1);
      for (let i = 0; i < 3; i++) {
        setSystemTime(start + i * DAY);
        await apply(app, `old-${i}`);
      }
      setSystemTime(start + 60 * DAY);
      await apply(app, "recent");
      const cutoff = start + 30 * DAY;

      expect(await prune(app, { beforeMs: cutoff, limit: 2 })).toEqual({ deleted: 2 });
      expect(await prune(app, { beforeMs: cutoff })).toEqual({ deleted: 1 });
      expect(await prune(app, { beforeMs: cutoff })).toEqual({ deleted: 0 });

      // The recent id is still remembered, so its replay is a no-op.
      expect(await apply(app, "recent")).toEqual({ duplicate: true, eventId: "recent" });
    } finally {
      await app.close();
    }
  });

  test("clamps the limit to at least one row", async () => {
    const app = await open();
    try {
      await apply(app, "a");
      await apply(app, "b");
      expect(await prune(app, { beforeMs: Date.now() + 1, limit: 0 })).toEqual({ deleted: 1 });
    } finally {
      await app.close();
    }
  });
});
