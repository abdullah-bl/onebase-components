// The push component: device registration flows and provider routing guards.
// Sends against real providers belong to the client tests above; here the
// registry and the no-provider path run inside a mounted runtime.

import { describe, expect, test } from "bun:test";
import { defineComponents } from "onebase/components";
import { defineSchema } from "onebase/server";
import { push } from "../src/index";
import { call, callMutation, openRuntime, type TestApp } from "../../../test/app";

const appSchema = defineSchema({});

function components(config: Parameters<typeof push>[0]) {
  // Exposed so the tests can call the functions the way clients would.
  return defineComponents({ push: push({ ...config, expose: ["register", "unregister", "listDevices", "sendToUser", "sendToUsers"] } as any) as any });
}

const TOKEN = "a".repeat(64);

const register = (app: TestApp, args: Record<string, unknown>) => callMutation(app, "push:register", args);
const devices = (app: TestApp, subject: string) => call(app, "push:listDevices", { subject }).then((r) => r.value);

async function open(config: Parameters<typeof push>[0]) {
  return openRuntime({ schema: appSchema, modules: {}, components: components(config) });
}

describe("push registry", () => {
  const fcmOnly = { fcm: { credentials: { client_email: "a@b", private_key: "x" } } };

  test("register, list, and unregister", async () => {
    const app = await open(fcmOnly);
    try {
      await register(app, { token: TOKEN, subject: "u1", platform: "ios", environment: "sandbox", locale: "en" });
      await register(app, { token: TOKEN + "b".repeat(4), subject: "u1", platform: "android" });
      expect(await devices(app, "u1")).toEqual([
        { token: TOKEN, platform: "ios", environment: "sandbox", locale: "en" },
        { token: TOKEN + "b".repeat(4), platform: "android", environment: "production", locale: null },
      ]);
      await callMutation(app, "push:unregister", { token: TOKEN });
      expect(await devices(app, "u1")).toEqual([{ token: TOKEN + "b".repeat(4), platform: "android", environment: "production", locale: null }]);
    } finally {
      await app.close();
    }
  });

  test("a token follows whoever signed in last", async () => {
    const app = await open(fcmOnly);
    try {
      await register(app, { token: TOKEN, subject: "u1", platform: "ios" });
      await register(app, { token: TOKEN, subject: "u2", platform: "ios" });
      expect(await devices(app, "u1")).toEqual([]);
      expect(await devices(app, "u2")).toEqual([{ token: TOKEN, platform: "ios", environment: "production", locale: null }]);
    } finally {
      await app.close();
    }
  });

  test("rejects tokens that are too short and unknown platforms", async () => {
    const app = await open(fcmOnly);
    try {
      await expect(register(app, { token: "short", subject: "u1", platform: "ios" })).rejects.toThrow("device token");
      await expect(register(app, { token: TOKEN, subject: "u1", platform: "flip" })).rejects.toThrow('Unknown platform "flip"');
    } finally {
      await app.close();
    }
  });

  test("sends route by platform and report what a provider refused", async () => {
    const app = await open(fcmOnly);
    try {
      await register(app, { token: TOKEN, subject: "u1", platform: "ios" });
      const report = (await app.runtime.runAction("components/push:sendToUser", { subject: "u1", payload: { title: "Hi" } })) as {
        sent: number;
        failures: { token: string; reason: string }[];
      };
      expect(report.sent).toBe(0);
      expect(report.failures).toEqual([{ token: TOKEN, reason: "no apns configured" }]);
      // The device is kept: a missing provider is not a dead token.
      expect(await devices(app, "u1")).toEqual([{ token: TOKEN, platform: "ios", environment: "production", locale: null }]);
      await expect(app.runtime.runAction("components/push:sendToUsers", { subjects: Array.from({ length: 101 }, (_, i) => `u${i}`), payload: {} })).rejects.toThrow(
        "At most 100",
      );
    } finally {
      await app.close();
    }
  });

  test("at least one provider must be configured", () => {
    expect(() => components({})).toThrow("at least one of apns or fcm");
  });
});
