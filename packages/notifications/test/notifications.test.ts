// Notifications: publish/list/read lifecycle, dedupe, the email channel (with the
// "fake" provider so delivery runs end to end without network), and pruning.

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { defineComponents } from "onebase/components";
import { defineSchema } from "onebase/server";
import { emailFor, notifications } from "../src/index";
import { call, callMutation, openRuntime, type TestApp } from "../../../test/app";

const appSchema = defineSchema({});

const components = () =>
  defineComponents({
    notes: notifications({
      email: { provider: "fake" as any, apiKey: "test", from: "App <no-reply@app.com>", severity: ["error", "warning"] },
      expose: ["publish", "list", "unreadCount", "markAllRead"],
    } as any) as any,
  });

async function open() {
  return openRuntime({ schema: appSchema, modules: {}, components: components() });
}

const publish = (app: TestApp, args: Record<string, unknown>) => callMutation(app, "notes:publish", args);
const list = (app: TestApp, subject: string, limit?: number) =>
  call(app, "notes:list", limit === undefined ? { subject } : { subject, limit }).then((r) => r.value as any[]);
const unread = (app: TestApp, subject: string) => call(app, "notes:unreadCount", { subject }).then((r) => r.value);

describe("notifications", () => {
  test("publish, list, unread, markAllRead", async () => {
    const app = await open();
    try {
      expect(await publish(app, { subject: "u1", kind: "screen.offline", title: "Lobby went offline", severity: "warning", body: "It stopped reporting." })).not.toBeNull();
      await publish(app, { subject: "u1", kind: "billing.renewed", title: "Subscription renewed", severity: "success" });
      await publish(app, { subject: "u2", kind: "screen.offline", title: "Other subject" });

      const feed = await list(app, "u1");
      expect(feed).toHaveLength(2);
      expect(feed[0]).toMatchObject({ title: "Subscription renewed", severity: "success", read: false });
      expect(feed[1]).toMatchObject({ title: "Lobby went offline", body: "It stopped reporting.", read: false });
      expect(await unread(app, "u1")).toBe(2);
      expect(await unread(app, "u2")).toBe(1);

      await callMutation(app, "notes:markAllRead", { subject: "u1" });
      expect(await unread(app, "u1")).toBe(0);
      expect((await list(app, "u1")).map((n: any) => n.read)).toEqual([true, true]);
      // Marking read doesn't touch other subjects.
      expect(await unread(app, "u2")).toBe(1);
    } finally {
      await app.close();
    }
  });

  test("dedupeKey collapses repeats per key", async () => {
    const app = await open();
    try {
      expect(await publish(app, { subject: "u1", kind: "k", title: "t", dedupeKey: "s1-offline" })).not.toBeNull();
      expect(await publish(app, { subject: "u1", kind: "k", title: "t again", dedupeKey: "s1-offline" })).toBeNull();
      // A different key publishes normally.
      expect(await publish(app, { subject: "u1", kind: "k", title: "t2", dedupeKey: "s2-offline" })).not.toBeNull();
      expect(await list(app, "u1")).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  test("list limits to the newest entries", async () => {
    const app = await open();
    try {
      for (let i = 0; i < 5; i++) {
        await publish(app, { subject: "u1", kind: "k", title: `t${i}`, metadata: { i } });
      }
      const feed = await list(app, "u1", 3);
      expect(feed.map((n: any) => n.title)).toEqual(["t4", "t3", "t2"]);
      expect(feed[0]?.metadata).toEqual({ i: 4 });
    } finally {
      await app.close();
    }
  });

  test("the email channel delivers matching severities only", async () => {
    const app = await open();
    try {
      await publish(app, { subject: "u1", kind: "k.info", title: "Quiet note", emailTo: "u1@x.com" });
      await publish(app, { subject: "u1", kind: "k.down", title: "Down hard", severity: "error", emailTo: "u1@x.com" });
      await app.runtime.startScheduler();
      // The fake provider "delivers" instantly; the info event was never scheduled.
      for (let i = 0; i < 50; i++) {
        const feed = await list(app, "u1");
        if (feed.find((n: any) => n.emailedTo)) break;
        await Bun.sleep(20);
      }
      const feed = await list(app, "u1");
      const byTitle = Object.fromEntries(feed.map((n: any) => [n.title, n.emailedTo]));
      expect(byTitle["Quiet note"]).toBeNull();
      expect(byTitle["Down hard"]).toBe("u1@x.com");
    } finally {
      await app.close();
    }
  });

  test("prune drops events past the retention window", async () => {
    const app = await open();
    try {
      setSystemTime(Date.UTC(2026, 0, 1));
      await publish(app, { subject: "u1", kind: "k", title: "old" });
      setSystemTime(Date.now() + 31 * 86_400_000);
      await publish(app, { subject: "u1", kind: "k", title: "new" });
      await app.runtime.runMutation("components/notes:prune", {}, { allowInternal: true, source: "dashboard" });
      const titles = (await list(app, "u1")).map((n: any) => n.title);
      expect(titles).toEqual(["new"]);
    } finally {
      await app.close();
    }
  });

  test("emailFor renders templates", () => {
    const channel = {
      provider: "resend" as const,
      apiKey: "k",
      from: "x@app.com",
      subjectTemplate: "[{{ severity }}] {{ title }}",
      textTemplate: "{{ body }}",
    };
    expect(emailFor({ to: "a@x.com", kind: "k", severity: "warning", title: "Down", body: "It stopped." }, channel)).toEqual({
      to: "a@x.com",
      subject: "[warning] Down",
      text: "It stopped.",
    });
  });
});
