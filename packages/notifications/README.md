# @onebase/notifications

An in-app notification feed. Your backend publishes events for a subject (a user id or a team id), clients show them with live queries, and a per-subject read marker drives the unread badge. Optionally, some of them also go out by email.

## Install

```bash
bun add @onebase/notifications
```

Until the package is on npm, depend on a checkout of this repository instead: `bun add @onebase/notifications@file:../onebase-components/packages/notifications`. It uses [`@onebase/email`](../email) for the email channel.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { notifications } from "@onebase/notifications";

export default defineComponents({
  notes: notifications({
    retentionMs: 30 * 86_400_000,
    email: {
      provider: "resend",
      apiKey: process.env.RESEND_API_KEY!,
      from: "My App <no-reply@example.com>",
      severity: ["warning", "error"],
      subjectTemplate: "[{{ severity }}] {{ title }}",
      textTemplate: "{{ body }}",
    },
  }),
});
```

| Option | Default | |
|---|---|---|
| `retentionMs` | 30 days | Notifications older than this are deleted by an hourly cron. |
| `email` | none | Leave it out for an in-app feed only. |
| `email.provider` | | `"resend"` or `"postmark"`. |
| `email.apiKey` | | A Resend API key or a Postmark server token. |
| `email.from` | | The sender, such as `My App <no-reply@example.com>`. |
| `email.severity` | all | Only these severities are emailed. |
| `email.subjectTemplate`, `textTemplate`, `htmlTemplate` | `{{ title }}`, none, none | Templates with `{{ title }}`, `{{ body }}`, `{{ kind }}` and `{{ severity }}` placeholders. |

Templates are strings rather than functions because the component sends email from an action on a worker thread, and functions in the configuration can't cross to it.

## Use it

Publish from any mutation:

```ts
await ctx.components.notes.publish({
  subject: userId,
  kind: "screen.offline",
  severity: "warning",
  title: "Lobby went offline",
  body: "It stopped reporting 5 minutes ago.",
  metadata: { screenId },
  dedupeKey: `screen-offline:${screenId}:${day}`,
  emailTo: userEmail,
});
```

`severity` is `info` (the default), `success`, `warning` or `error`. A `dedupeKey` that was already published makes the call a no-op that returns `null`, so a check that runs every minute can publish freely. Keys are global, not per subject, so put the subject or the object's id in them. With `emailTo` and an email channel that covers the severity, the email is sent right after the mutation commits.

Show the feed with your own queries, which pass the signed-in user as the subject:

```ts
// onebase/feed.ts
import { mutation, query, getAuthUserId } from "onebase/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const me = await getAuthUserId(ctx);
    return me ? ctx.components.notes.list({ subject: me, limit: 20 }) : [];
  },
});

export const unread = query({
  args: {},
  handler: async (ctx) => {
    const me = await getAuthUserId(ctx);
    return me ? ctx.components.notes.unreadCount({ subject: me }) : 0;
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await getAuthUserId(ctx);
    if (me) await ctx.components.notes.markAllRead({ subject: me });
  },
});
```

Exposing the component's functions directly would let any client read or publish to any subject's feed, so wrap them like this.

## Functions

| | |
|---|---|
| `publish({ subject, kind, title, severity?, body?, metadata?, dedupeKey?, emailTo? })` | Mutation. Adds a notification and returns its id, or `null` for a duplicate `dedupeKey`. |
| `list({ subject, limit? })` | Live query. The newest notifications first, 50 by default: `[{ id, kind, severity, title, body, metadata, createdAtMs, emailedTo, read }]`. |
| `unreadCount({ subject })` | Live query. How many arrived since the subject last marked them read. |
| `markAllRead({ subject })` | Mutation. Marks everything up to now as read. |

`emailFor(input, channel)` is exported as a plain function that returns the message a notification would become, for previews and tests.

## Notes

- Read state is one timestamp per subject, so there's no marking a single notification read.
- `emailedTo` is set once the email has been handed to the provider. A failed send doesn't stop the notification from showing in the feed.
- The hourly cleanup deletes up to 500 expired notifications per run.
- Tables: `events` and `reads`. They're listed under the mount name on the dashboard's Data page.
