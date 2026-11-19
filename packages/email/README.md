# @onebase/email

Email transports for OneBase apps: Resend, Postmark and SMTP behind one `send` call, plus a ready-made `sendCode` for [password auth](https://abdullah-bl.github.io/onebase/docs/auth.html). This is a library rather than a component: sending email needs no tables and no scheduler, so there's nothing to mount.

## Install

```bash
bun add @onebase/email
```

Until the package is on npm, depend on a checkout of this repository instead: `bun add @onebase/email@file:../onebase-components/packages/email`. For SMTP, also `bun add nodemailer`; Resend and Postmark need nothing else.

## Pick a transport

```ts
import { createResend, createPostmark, createSmtp } from "@onebase/email";

const resend = createResend({ apiKey: process.env.RESEND_API_KEY! });
const postmark = createPostmark({ serverToken: process.env.POSTMARK_TOKEN! });
const smtp = createSmtp({ host: "smtp.example.com", port: 465, auth: { user: "app", pass: process.env.SMTP_PASSWORD! } });

await resend.send({
  from: "My App <no-reply@example.com>",
  to: "ada@example.com",
  subject: "Welcome",
  text: "Thanks for signing up.",
  html: "<p>Thanks for signing up.</p>",
});
```

Every transport has the same shape, `{ name, send(message) }`, so you can choose one by environment and pass it around. A message is `{ from, to, subject, text?, html?, replyTo?, headers? }`, where `to` is one address or a list. `send` returns `{ id }` from the provider and throws when the provider refuses the message.

Sending calls a remote API, so call `send` from an action, a scheduled action or an HTTP action, not from a query or mutation.

| Transport | Options |
|---|---|
| `createResend` | `apiKey`, `baseUrl?` |
| `createPostmark` | `serverToken`, `baseUrl?` |
| `createSmtp` | `host`, `port?`, `secure?` (default: true on port 465), `auth: { user, pass }`, `from?` to override every message's sender |

## Codes for password auth

`createSendCode` builds the `sendCode` function that onebase's `password()` method calls to email a verification or password-reset code:

```ts
// onebase/auth.config.ts
import { password } from "onebase/auth";
import { createResend, createSendCode } from "@onebase/email";

export default {
  methods: [
    password({
      verifyEmail: true,
      sendCode: createSendCode({
        transport: createResend({ apiKey: process.env.RESEND_API_KEY! }),
        from: "My App <no-reply@example.com>",
      }),
    }),
  ],
};
```

`sendCode` runs on the server, where `fetch` is allowed, so it calls the transport directly. The default templates say "Confirm your email" and "Reset your password" and mention that the code expires in 15 minutes. Replace either with `templates`:

```ts
createSendCode({
  transport,
  from: "My App <no-reply@example.com>",
  templates: {
    reset: { subject: "Your reset code", text: "Use {{ code }} to reset the password for {{ email }}." },
  },
});
```

Templates can use `{{ code }}`, `{{ email }}` and `{{ purpose }}` (`verify` or `reset`). `DEFAULT_TEMPLATES` and `render(template, vars)` are exported too.

## Notes

- `nodemailer` is loaded only when an SMTP message is sent, and the error says to install it if it's missing.
- `createResend` and `createPostmark` take a `fetchImpl` option, which tests use to send without a network.
- [`@onebase/notifications`](../notifications) uses these transports for its email channel.
