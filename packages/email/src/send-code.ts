// sendCode for onebase's password auth (`password({ sendCode: createSendCode({...}) })`).
// The callback runs on the server, where fetch is allowed, so the transport is called
// directly — no action plumbing needed.

import type { Transport } from "./types";

export type SendCodeMessage = {
  email: string;
  code: string;
  purpose: "verify" | "reset";
};

/** Structurally the `SendCode` callback onebase's `password()` takes. */
export type SendCodeFn = (message: SendCodeMessage, ctx?: unknown) => Promise<void>;

export type CodeTemplate = {
  subject: string;
  text?: string;
  html?: string;
};

/** Replaces `{{ key }}` placeholders; unknown keys render as empty. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => vars[key] ?? "");
}

export const DEFAULT_TEMPLATES: Record<SendCodeMessage["purpose"], CodeTemplate> = {
  verify: {
    subject: "Confirm your email",
    text: "Your confirmation code is {{ code }}. It expires in 15 minutes.",
    html: '<p>Your confirmation code is <strong>{{ code }}</strong>. It expires in 15 minutes.</p>',
  },
  reset: {
    subject: "Reset your password",
    text: "Your reset code is {{ code }}. It expires in 15 minutes.",
    html: '<p>Your reset code is <strong>{{ code }}</strong>. It expires in 15 minutes.</p>',
  },
};

export function createSendCode(options: {
  transport: Transport;
  from: string;
  /** Overrides per purpose; pass `{ verify: null, reset: null }`-style entries to replace defaults. */
  templates?: Partial<Record<SendCodeMessage["purpose"], CodeTemplate>>;
}): SendCodeFn {
  return async ({ email, code, purpose }) => {
    const template = options.templates?.[purpose] ?? DEFAULT_TEMPLATES[purpose];
    const vars = { code, email, purpose };
    const message: Parameters<Transport["send"]>[0] = {
      from: options.from,
      to: email,
      subject: render(template.subject, vars),
    };
    if (template.text) message.text = render(template.text, vars);
    if (template.html) message.html = render(template.html, vars);
    await options.transport.send(message);
  };
}
