// Notifications and applyStoreEvent ordering, with real signed payloads where the
// signature matters and synthetic store events where only ordering matters.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineComponents } from "onebase/components";
import { defineSchema } from "onebase/server";
import { appStore, notificationEventType, type StoreEvent } from "../src/index";
import { buildChain, signJws, type Chain } from "./chains";
import { call, openRuntime, startApp, type TestApp } from "../../../test/app";

const BUNDLE = "com.test.app";
const USER = "11111111-1111-4111-8111-111111111111";
const appSchema = defineSchema({});

let chain: Chain;
const config = () => ({ bundleId: BUNDLE, products: ["pro_monthly", "pro_yearly"], root: chain.root, expose: ["getSubscription"] as const });
const components = () => defineComponents({ store: appStore(config()) as any });

function tx(overrides: Record<string, unknown> = {}) {
  return {
    bundleId: BUNDLE,
    productId: "pro_yearly",
    transactionId: "2000000000009",
    originalTransactionId: "1000000000009",
    appAccountToken: USER,
    expiresDate: 1_900_000_000_000,
    environment: "Production",
    ...overrides,
  };
}

async function signedNotification(type: string, subtype?: string, txOverrides: Record<string, unknown> = {}, opts: { uuid?: string; signedDate?: number } = {}) {
  return signJws(chain, {
    notificationType: type,
    subtype,
    notificationUUID: opts.uuid ?? `uuid-${type}-${subtype ?? ""}`,
    signedDate: opts.signedDate ?? 1_800_000_000_000,
    data: {
      bundleId: BUNDLE,
      environment: "Production",
      signedTransactionInfo: await signJws(chain, tx(txOverrides)),
    },
  });
}

/** A synthetic store event, for driving applyStoreEvent's ordering rules directly. */
function event(overrides: Partial<StoreEvent> & Pick<StoreEvent, "id" | "type">): StoreEvent {
  return {
    app_user_id: USER,
    product_id: "pro_yearly",
    period_type: "NORMAL",
    expiration_at_ms: 1_900_000_000_000,
    original_transaction_id: "1000000000009",
    transaction_id: "2000000000009",
    environment: "PRODUCTION",
    event_at_ms: 1_800_000_000_000,
    ...overrides,
  };
}

const apply = (app: TestApp, e: StoreEvent) =>
  app.runtime.runMutation("components/store:applyStoreEvent", { event: e }, { allowInternal: true, source: "dashboard" });

const subscription = (app: TestApp) => call(app, "store:getSubscription", { subject: USER }).then((r) => r.value);

beforeAll(async () => {
  chain = await buildChain({ markers: true });
});

async function startWebhookApp() {
  const dataDir = mkdtempSync(join(tmpdir(), "onebase-store-http-"));
  const app = await startApp({ schema: appSchema, modules: {}, components: components(), dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true });
  const base = `http://127.0.0.1:${app.server.port}`;
  const post = (body: unknown) =>
    fetch(`${base}/store/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const storedSubscription = async () => {
    const res = await fetch(`${base}/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "components/store:getSubscription", args: { subject: USER } }),
    });
    return ((await res.json()) as { value: unknown }).value;
  };
  return {
    app,
    post,
    storedSubscription,
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

describe("notification type mapping", () => {
  test("maps the lifecycle types", () => {
    expect(notificationEventType("SUBSCRIBED", "INITIAL_BUY")).toBe("INITIAL_PURCHASE");
    expect(notificationEventType("SUBSCRIBED", "RESUBSCRIBE")).toBe("INITIAL_PURCHASE");
    expect(notificationEventType("DID_CHANGE_RENEWAL_PREF", "UPGRADE")).toBe("PRODUCT_CHANGE");
    expect(notificationEventType("DID_CHANGE_RENEWAL_PREF", "DOWNGRADE")).toBeNull();
    expect(notificationEventType("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_DISABLED")).toBe("CANCELLATION");
    expect(notificationEventType("DID_CHANGE_RENEWAL_STATUS", "AUTO_RENEW_ENABLED")).toBe("UNCANCELLATION");
    expect(notificationEventType("DID_FAIL_TO_RENEW", "GRACE_PERIOD")).toBe("BILLING_ISSUE");
    expect(notificationEventType("EXPIRED", "VOLUNTARY")).toBe("EXPIRATION");
    expect(notificationEventType("GRACE_PERIOD_EXPIRED")).toBe("EXPIRATION");
    expect(notificationEventType("REFUND")).toBe("REFUND");
    expect(notificationEventType("REVOKE")).toBe("REFUND");
    expect(notificationEventType("TEST")).toBeNull();
    expect(notificationEventType("PRICE_INCREASE")).toBeNull();
  });
});

describe("webhook", () => {
  test("applies a renewal end to end over HTTP", async () => {
    const server = await startWebhookApp();
    try {
      const response = await server.post({ signedPayload: await signedNotification("DID_RENEW", "BILLING_RECOVERY") });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, status: "active" });
      expect(await server.storedSubscription()).toMatchObject({
        subject: USER,
        productId: "pro_yearly",
        status: "active",
        environment: "PRODUCTION",
        expiresAtMs: 1_900_000_000_000,
        originalTransactionId: "1000000000009",
      });
    } finally {
      await server.close();
    }
  });

  test("rejects bad bodies and bad signatures with 400", async () => {
    const server = await startWebhookApp();
    try {
      expect((await server.post({})).status).toBe(400);
      expect((await server.post("not json")).status).toBe(400);
      expect((await server.post({ signedPayload: "forged" })).status).toBe(400);
    } finally {
      await server.close();
    }
  });

  test("acknowledges types we do not act on, other apps, and unknown products", async () => {
    const server = await startWebhookApp();
    try {
      const test = await server.post({ signedPayload: await signedNotification("TEST") });
      expect(test.status).toBe(200);
      expect(((await test.json()) as { ignored?: string }).ignored).toBeDefined();
      expect((await server.post({ signedPayload: await signedNotification("DID_RENEW", undefined, { bundleId: "com.other.app" }) })).status).toBe(200);
      expect((await server.post({ signedPayload: await signedNotification("DID_RENEW", undefined, { productId: "gold" }) })).status).toBe(200);
      expect(await server.storedSubscription()).toBeNull();
    } finally {
      await server.close();
    }
  });
});

describe("applyStoreEvent ordering", () => {
  test("replays are duplicates", async () => {
    const app = await openRuntime({ schema: appSchema, modules: {}, components: components() });
    try {
      expect(await apply(app, event({ id: "uuid-1", type: "RENEWAL" }))).toMatchObject({ status: "active" });
      expect(await apply(app, event({ id: "uuid-1", type: "RENEWAL" }))).toMatchObject({ duplicate: true });
      expect(await subscription(app)).toMatchObject({ status: "active" });
    } finally {
      await app.close();
    }
  });

  test("a late notification does not undo a newer one", async () => {
    const app = await openRuntime({ schema: appSchema, modules: {}, components: components() });
    try {
      await apply(app, event({ id: "uuid-2", type: "EXPIRATION", event_at_ms: 2_000_000_000_000 }));
      expect(await subscription(app)).toMatchObject({ status: "canceled" });
      expect(await apply(app, event({ id: "uuid-3", type: "RENEWAL", event_at_ms: 1_800_000_000_000 }))).toMatchObject({
        ignored: true,
        reason: "stale event",
      });
      expect(await subscription(app)).toMatchObject({ status: "canceled" });
    } finally {
      await app.close();
    }
  });

  test("cancellation keeps the subscription until it expires", async () => {
    const app = await openRuntime({ schema: appSchema, modules: {}, components: components() });
    try {
      await apply(app, event({ id: "uuid-4", type: "RENEWAL" }));
      expect(await apply(app, event({ id: "uuid-5", type: "CANCELLATION" }))).toMatchObject({ status: "cancel_scheduled" });
      expect(await subscription(app)).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    } finally {
      await app.close();
    }
  });

  test("a refund sticks even when a synced transaction is older", async () => {
    const app = await openRuntime({ schema: appSchema, modules: {}, components: components() });
    try {
      await apply(app, event({ id: "uuid-6", type: "REFUND", event_at_ms: 2_000_000_000_000 }));
      expect(await subscription(app)).toMatchObject({ status: "refunded" });
      // The app reports what it can see — signed before the refund — and must not undo it.
      expect(await apply(app, event({ id: "sync:1", type: "SYNC", event_at_ms: 1_800_000_000_000 }))).toMatchObject({
        ignored: true,
        reason: "stale event",
      });
      expect(await subscription(app)).toMatchObject({ status: "refunded" });
    } finally {
      await app.close();
    }
  });

  test("one subscription pays for one account", async () => {
    const app = await openRuntime({ schema: appSchema, modules: {}, components: components() });
    try {
      await apply(app, event({ id: "uuid-7", type: "RENEWAL" }));
      expect(
        await apply(app, event({ id: "uuid-8", type: "RENEWAL", app_user_id: "22222222-2222-4222-8222-222222222222" })),
      ).toMatchObject({ ignored: true, reason: "subscription belongs to another account" });
      expect(await subscription(app)).toMatchObject({ subject: USER });
    } finally {
      await app.close();
    }
  });

  test("a renewal without an account token finds its owner by transaction", async () => {
    const app = await openRuntime({ schema: appSchema, modules: {}, components: components() });
    try {
      await apply(app, event({ id: "uuid-9", type: "INITIAL_PURCHASE" }));
      expect(
        await apply(app, event({ id: "uuid-10", type: "RENEWAL", app_user_id: "", event_at_ms: 1_850_000_000_000 })),
      ).toMatchObject({ status: "active" });
      expect(await subscription(app)).toMatchObject({ subject: USER });
    } finally {
      await app.close();
    }
  });
});
