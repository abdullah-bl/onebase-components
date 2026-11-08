// SMTP via nodemailer, imported dynamically so the package stays dependency-free
// for Resend and Postmark users. Apps that send over SMTP install nodemailer
// themselves (`bun add nodemailer`).

import type { EmailMessage, SendResult, Transport } from "../types";

export type SmtpOptions = {
  host: string;
  port?: number;
  /** Implicit TLS (default: true on port 465, false otherwise). */
  secure?: boolean;
  auth: { user: string; pass: string };
  /** Overrides message.from when set — handy for one app mailbox. */
  from?: string;
};

export function createSmtp(options: SmtpOptions): Transport {
  return {
    name: "smtp",
    async send(message: EmailMessage): Promise<SendResult> {
      const specifier = "nodemailer";
      const nodemailer = await import(specifier).catch(() => null);
      if (!nodemailer) {
        throw new Error("smtp transport needs the optional dependency nodemailer (bun add nodemailer).");
      }
      const transport = nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure ?? options.port === 465,
        auth: options.auth,
      });
      const info = await transport.sendMail({
        from: options.from ?? message.from,
        to: Array.isArray(message.to) ? message.to.join(", ") : message.to,
        subject: message.subject,
        ...(message.text ? { text: message.text } : {}),
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
      });
      return { id: info?.messageId };
    },
  };
}
