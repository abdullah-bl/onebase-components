// Email as a library, not a component: transports have no tables and no scheduler,
// so there is nothing a mount would add. Pick a transport, call `send`.

export type EmailMessage = {
  from: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
};

export type SendResult = { id?: string };

/** Anything that can deliver an EmailMessage. All transports in this package implement it. */
export type Transport = {
  /** "resend", "postmark", "smtp" — useful for logs and routing decisions. */
  name: string;
  send(message: EmailMessage): Promise<SendResult>;
};

export type TransportOptions = {
  fetchImpl?: typeof fetch;
};
