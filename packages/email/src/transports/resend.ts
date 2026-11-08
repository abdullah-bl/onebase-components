// Resend over its HTTP API. https://resend.com/docs/api-reference

import type { EmailMessage, SendResult, Transport, TransportOptions } from "../types";

export function createResend(options: { apiKey: string; baseUrl?: string } & TransportOptions): Transport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.resend.com";
  return {
    name: "resend",
    async send(message: EmailMessage): Promise<SendResult> {
      const response = await fetchImpl(`${baseUrl}/emails`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: message.from,
          to: Array.isArray(message.to) ? message.to : [message.to],
          subject: message.subject,
          ...(message.text ? { text: message.text } : {}),
          ...(message.html ? { html: message.html } : {}),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          ...(message.headers ? { headers: message.headers } : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as { id?: string; message?: string } | null;
      if (!response.ok) throw new Error(`resend: ${body?.message ?? `HTTP ${response.status}`}`);
      return { id: body?.id };
    },
  };
}
