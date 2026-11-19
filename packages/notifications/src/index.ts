// The in-app notification feed. Events are published per subject (a user or team
// id), clients subscribe live (`list`, `unreadCount`), and `markAllRead` keeps a
// per-subject read marker. An optional email channel delivers selected severities
// through a scheduled action.
//
//   // onebase/components.ts
//   export default defineComponents({
//     notes: notifications({
//       email: { provider: "resend", apiKey: process.env.RESEND_API_KEY!, from: "App <no-reply@app.com>" },
//     }),
//   });
//
//   // in an app mutation
//   await ctx.components.notes.publish({
//     subject: userId, kind: "screen.offline", severity: "warning",
//     title: "Lobby went offline", body: "It stopped reporting.",
//     dedupeKey: `screen-offline:${screenId}`, emailTo: userEmail,
//   });
//
// Email templates are strings with {{ title }} / {{ body }} / {{ kind }} / {{ severity }}
// placeholders, so the whole config stays data: component actions run on a worker
// thread that functions in config cannot cross.

import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "onebase/components";
import { OneBaseError, defineSchema, defineTable, type DataModelFromSchema } from "onebase/server";
import { v } from "onebase/values";
import { createPostmark, createResend, type Transport } from "@onebase/email";

const SEVERITIES = ["info", "success", "warning", "error"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type EmailChannel = {
  provider: "resend" | "postmark";
  /** API key (Resend) or server token (Postmark). */
  apiKey: string;
  from: string;
  /** Only these severities are emailed (default: all). */
  severity?: Severity[];
  subjectTemplate?: string;
  textTemplate?: string;
  htmlTemplate?: string;
};

export type NotificationsConfig = {
  /** Events older than this are pruned hourly (default 30 days). */
  retentionMs?: number;
  email?: EmailChannel;
};

const schema = defineSchema({
  events: defineTable({
    subject: v.string(),
    kind: v.string(),
    severity: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    metadata: v.optional(v.any()),
    dedupeKey: v.optional(v.string()),
    createdAtMs: v.number(),
    emailedTo: v.optional(v.string()),
    emailedAtMs: v.optional(v.number()),
  })
    .index("by_subject_createdAt", ["subject", "createdAtMs"])
    .index("by_dedupe", ["dedupeKey"]),
  reads: defineTable({
    subject: v.string(),
    lastReadAtMs: v.number(),
  }).index("by_subject", ["subject"]),
});

const { action, internalAction, internalMutation, internalQuery, mutation, query } = componentServer<DataModelFromSchema<typeof schema>, NotificationsConfig>();

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => vars[key] ?? "");
}

const findEvent = async (ctx: any, id: string) => (await ctx.db.get(id)) as any;
const findRead = async (ctx: any, subject: string) =>
  ctx.db.query("reads").withIndex("by_subject", (q: any) => q.eq("subject", subject)).unique();

/** The email message one notification becomes; exported pure for tests. */
export function emailFor(input: { to: string; kind: string; severity: string; title: string; body?: string; metadata?: unknown }, channel: EmailChannel): { to: string; subject: string; text?: string; html?: string } {
  const vars = { title: input.title, body: input.body ?? "", kind: input.kind, severity: input.severity };
  const out: { to: string; subject: string; text?: string; html?: string } = {
    to: input.to,
    subject: render(channel.subjectTemplate ?? "{{ title }}", vars),
  };
  if (channel.textTemplate) out.text = render(channel.textTemplate, vars);
  if (channel.htmlTemplate) out.html = render(channel.htmlTemplate, vars);
  return out;
}

const publish = mutation({
  args: {
    subject: v.string(),
    kind: v.string(),
    title: v.string(),
    severity: v.optional(v.string()),
    body: v.optional(v.string()),
    metadata: v.optional(v.any()),
    dedupeKey: v.optional(v.string()),
    emailTo: v.optional(v.string()),
  },
  handler: async (ctx, { subject, kind, title, severity = "info", body, metadata, dedupeKey, emailTo }) => {
    if (!SEVERITIES.includes(severity as Severity)) throw new OneBaseError(`Unknown severity "${severity}".`);
    if (dedupeKey) {
      const seen = await ctx.db.query("events").withIndex("by_dedupe", (q: any) => q.eq("dedupeKey", dedupeKey)).unique();
      if (seen) return null;
    }
    const id = await ctx.db.insert("events", { subject, kind, severity, title, body, metadata, dedupeKey, createdAtMs: Date.now() });

    const channel = ctx.config.email;
    if (channel && emailTo && (!channel.severity || channel.severity.includes(severity as Severity))) {
      const message = emailFor({ to: emailTo, kind, severity, title, body }, channel);
      await ctx.scheduler.runAfter(0, deliverEmail, { eventId: id as string, ...message });
    }
    return id as string;
  },
});

/** The subject's newest notifications; a live query. */
const list = query({
  args: { subject: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { subject, limit = 50 }) => {
    const rows = await ctx.db.query("events").withIndex("by_subject_createdAt", (q: any) => q.eq("subject", subject)).collect();
    const lastRead = (await findRead(ctx, subject))?.lastReadAtMs ?? 0;
    return rows
      .sort((a: any, b: any) => b.createdAtMs - a.createdAtMs || Number(b._creationTime) - Number(a._creationTime))
      .slice(0, limit)
      .map((row: any) => ({
        id: row._id as string,
        kind: row.kind as string,
        severity: row.severity as string,
        title: row.title as string,
        body: (row.body as string | undefined) ?? null,
        metadata: (row.metadata as unknown) ?? null,
        createdAtMs: row.createdAtMs as number,
        emailedTo: (row.emailedTo as string | undefined) ?? null,
        read: (row.createdAtMs as number) <= lastRead,
      }));
  },
});

/** How many notifications arrived after the subject last read; a live query. */
const unreadCount = query({
  args: { subject: v.string() },
  handler: async (ctx, { subject }) => {
    const lastRead = (await findRead(ctx, subject))?.lastReadAtMs ?? 0;
    const rows = await ctx.db.query("events").withIndex("by_subject_createdAt", (q: any) => q.eq("subject", subject).gt("createdAtMs", lastRead)).collect();
    return rows.length;
  },
});

const markAllRead = mutation({
  args: { subject: v.string() },
  handler: async (ctx, { subject }) => {
    const row = await findRead(ctx, subject);
    if (row) await ctx.db.patch(row._id, { lastReadAtMs: Date.now() });
    else await ctx.db.insert("reads", { subject, lastReadAtMs: Date.now() });
    return null;
  },
});

const getEvent = internalQuery({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }) => {
    const row = await findEvent(ctx, eventId);
    return row ? { subject: row.subject as string } : null;
  },
});

const markEmailed = internalMutation({
  args: { eventId: v.string(), to: v.string() },
  handler: async (ctx, { eventId, to }) => {
    const row = await findEvent(ctx, eventId);
    if (row) await ctx.db.patch(row._id, { emailedTo: to, emailedAtMs: Date.now() });
    return null;
  },
});

const deliverEmail = internalAction({
  args: { eventId: v.string(), to: v.string(), subject: v.string(), text: v.optional(v.string()), html: v.optional(v.string()) },
  handler: async (ctx, { eventId, to, subject, text, html }) => {
    const channel = (ctx.config as NotificationsConfig).email;
    if (!channel) return null;
    const transport: Transport =
      channel.provider === "resend"
        ? createResend({ apiKey: channel.apiKey })
        : channel.provider === "postmark"
          ? createPostmark({ serverToken: channel.apiKey })
          // "fake" is for tests: delivery succeeds without touching a provider.
          : { name: "fake", send: async () => ({ id: "fake" }) };
    await transport.send({ from: channel.from, to, subject, text, html });
    await ctx.runMutation(markEmailed, { eventId, to });
    return null;
  },
});

const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const before = Date.now() - (ctx.config.retentionMs ?? 30 * 86_400_000);
    // Oldest first; a compound-index range can't be used without a subject, so scan
    // a bounded batch from the front and stop at the first survivor.
    const oldest = await ctx.db.query("events").order("asc").take(500);
    for (const row of oldest) {
      if ((row.createdAtMs as number) >= before) break;
      await ctx.db.delete(row._id);
    }
    return null;
  },
});

export const definition = defineComponent({
  name: "notifications",
  schema,
  functions: { publish, list, unreadCount, markAllRead, getEvent, markEmailed, deliverEmail, prune },
  crons: () => [{ name: "prune", schedule: { minutes: 60 }, fn: prune }],
  checkConfig: (config: NotificationsConfig) => {
    if (config?.email && !["resend", "postmark", "fake"].includes(config.email.provider)) {
      throw new Error('notifications({ email }) provider must be "resend", "postmark" — or "fake" in tests.');
    }
  },
});

// ---- Types for the app ----

export type NotificationView = {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  metadata: unknown;
  createdAtMs: number;
  emailedTo: string | null;
  read: boolean;
};

export type PublishInput = {
  subject: string;
  kind: string;
  title: string;
  severity?: Severity;
  body?: string;
  metadata?: unknown;
  dedupeKey?: string;
  emailTo?: string;
};

export type NotificationsApi = {
  publish: ComponentFn<"mutation", (args: PublishInput) => Promise<string | null>>;
  list: ComponentFn<"query", (args: { subject: string; limit?: number }) => Promise<NotificationView[]>>;
  unreadCount: ComponentFn<"query", (args: { subject: string }) => Promise<number>>;
  markAllRead: ComponentFn<"mutation", (args: { subject: string }) => Promise<null>>;
};

/** Mounts notifications: `notifications({ email: { provider: "resend", apiKey, from } })`. */
export function notifications<const E extends keyof NotificationsApi = never>(
  opts: NotificationsConfig & MountOptions<E> = {},
): Mount<NotificationsApi, E> {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config, options) as unknown as Mount<NotificationsApi, E>;
}
