// syncTransactions: the client posts StoreKit 2 signed transactions; the server
// verifies, keeps the longest active one, and records it as a SYNC event.

import { beforeAll, describe, expect, test } from "bun:test";
import { defineComponents } from "onebase/components";
import { defineSchema } from "onebase/server";
import { appStore, type StoreEvent } from "../src/index";
import { buildChain, signJws, type Chain } from "./chains";
import { call, callMutation, openRuntime, type TestApp } from "../../../test/app";

const BUNDLE = "com.test.app";
const USER = "11111111-1111-4111-8111-111111111111";
const appSchema = defineSchema({});

let chain: Chain;
const components = () =>
  defineComponents({ store: appStore({ bundleId: BUNDLE, products: ["pro_monthly", "pro_yearly"], root: chain.root, expose: ["syncTransactions", "getSubscription"] as const }) as any });

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    bundleId: BUNDLE,
    productId: "pro_monthly",
    transactionId: "2000000000001",
    originalTransactionId: "1000000000001",
    appAccountToken: USER.toUpperCase(),
    expiresDate: Date.now() + 30 * 86_400_000,
    environment: "Sandbox",
    signedDate: Date.now(),
    ...overrides,
  };
}

const sync = (app: TestApp, transactions: string[], userId = USER) =>
  callMutation(app, "store:syncTransactions", { userId, signedTransactions: transactions });

const subscription = (app: TestApp, subject = USER) => call(app, "store:getSubscription", { subject }).then((r) => r.value);

const refundAt = async (app: TestApp, eventAtMs: number) => {
  const event: StoreEvent = {
    id: `refund:${eventAtMs}`,
    type: "REFUND",
    app_user_id: USER,
    product_id: "pro_monthly",
    period_type: "NORMAL",
    expiration_at_ms: null,
    original_transaction_id: "1000000000001",
    transaction_id: null,
    environment: "SANDBOX",
    event_at_ms: eventAtMs,
  };
  await app.runtime.runMutation("components/store:applyStoreEvent", { event }, { allowInternal: true, source: "dashboard" });
};

beforeAll(async () => {
  chain = await buildChain({ markers: true });
});

describe("syncTransactions", () => {
  test("records an uploaded subscription, matching the account token case-insensitively", async () => {
    const app = await openRuntime({ schema: appSchema, modules: {}, components: components() });
    try {
      await sync(app, [await signJws(chain, transaction())]);
      expect(await subscription(app)).toMatchObject({
        subject: USER,
        productId: "pro_monthly",
        status: "active",
        periodType: "NORMAL",
        environment: "SANDBOX",
        originalTransactionId: "1000000000001",
      });
    } finally {
      await app.close();
    }
  });

  test("keeps the longest active subscription", async () => {
    const app = await openRuntime({ schema: appSchema, modules: {}, components: components() });
    try {
      await sync(app, [
        await signJws(chain, transaction()),
        await signJws(
          chain,
          transaction({ productId: "pro_yearly", transactionId: "2000000000002", expiresDate: Date.now() + 365 * 86_400_000 }),
        ),
      ]);
      expect(await subscription(app)).toMatchObject({ productId: "pro_yearly", status: "active" });
    } finally {
      await app.close();
    }
  });

  test("marks an introductory offer as a trial", async () => {
    const app = await openRuntime({ schema: appSchema, modules: {}, components: components() });
    try {
      await sync(app, [await signJws(chain, transaction({ offerType: 1 }))]);
      expect(await subscription(app)).toMatchObject({ status: "trialing", periodType: "TRIAL" });
    } finally {
      await app.close();
    }
  });

  test("rejects forged, foreign, expired, revoked, and unknown transactions", async () => {
    const app = await openRuntime({ schema: appSchema, modules: {}, components: components() });
    try {
      await expect(sync(app, ["forged"])).rejects.toThrow("failed verification");
      await expect(sync(app, [await signJws(chain, transaction({ appAccountToken: "22222222-2222-4222-8222-222222222222" }))])).rejects.toThrow(
        "another account",
      );
      await expect(sync(app, [await signJws(chain, transaction({ appAccountToken: undefined }))])).rejects.toThrow("another account");
      await expect(sync(app, [await signJws(chain, transaction({ expiresDate: Date.now() - 1000 }))])).rejects.toThrow("No usable transactions");
      await expect(sync(app, [await signJws(chain, transaction({ revocationDate: Date.now() - 1000 }))])).rejects.toThrow("No usable transactions");
      await expect(sync(app, [await signJws(chain, transaction({ bundleId: "com.other.app" }))])).rejects.toThrow("No usable transactions");
      await expect(sync(app, [await signJws(chain, transaction({ productId: "gold_forever" }))])).rejects.toThrow("No usable transactions");
      await expect(sync(app, [])).rejects.toThrow("No signed transactions");
      const eleven = await Promise.all(Array.from({ length: 11 }, (_, i) => signJws(chain, transaction({ transactionId: String(i) }))));
      await expect(sync(app, eleven)).rejects.toThrow("Too many");
    } finally {
      await app.close();
    }
  });

  test("a sync signed before a refund does not undo the refund", async () => {
    const app = await openRuntime({ schema: appSchema, modules: {}, components: components() });
    try {
      // openssl certificates become valid at generation time; give them a second of
      // history so a transaction "signed a minute ago" verifies at its signedDate.
      await Bun.sleep(1_100);
      const refundTime = Date.now();
      await refundAt(app, refundTime);
      await sync(app, [await signJws(chain, transaction({ signedDate: refundTime - 1_000 }))]);
      expect(await subscription(app)).toMatchObject({ status: "refunded" });
    } finally {
      await app.close();
    }
  });

  test("replays and up-to-date syncs are no-ops", async () => {
    const app = await openRuntime({ schema: appSchema, modules: {}, components: components() });
    try {
      const jws = await signJws(chain, transaction());
      await sync(app, [jws]);
      const first = await subscription(app);
      // The exact same document replays as a duplicate event.
      expect(await sync(app, [jws])).toMatchObject({ duplicate: true });
      expect(await subscription(app)).toEqual(first);
      // A shorter, different transaction adds nothing we don't know.
      const shorter = await signJws(chain, transaction({ transactionId: "2000000000003", expiresDate: Date.now() + 20 * 86_400_000 }));
      expect(await sync(app, [shorter])).toMatchObject({ ignored: true, reason: "already up to date" });
      expect(await subscription(app)).toEqual(first);
    } finally {
      await app.close();
    }
  });
});
