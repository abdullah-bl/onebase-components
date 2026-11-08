// Postmark over its HTTP API. https://postmarkapp.com/developer/api/send/email

import type { EmailMessage, SendResult, Transport, TransportOptions } from "../types";

export function createPostmark(options: { serverToken: string; baseUrl?: string } & TransportOptions): Transport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.postmarkapp.com";
  return {
    name: "postmark",
    async send(message: EmailMessage): Promise<SendResult> {
      const response = await fetchImpl(`${baseUrl}/email`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "X-Postmark-Server-Token": options.serverToken,
        },
        body: JSON.stringify({
          From: message.from,
          To: Array.isArray(message.to) ? message.to.join(", ") : message.to,
          Subject: message.subject,
          ...(message.text ? { TextBody: message.text } : {}),
          ...(message.html ? { HtmlBody: message.html } : {}),
          ...(message.replyTo ? { ReplyTo: message.replyTo } : {}),
          ...(message.headers
            ? { Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })) }
            : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as { MessageID?: string; ErrorCode?: number; Message?: string } | null;
      if (!response.ok || (body?.ErrorCode !== undefined && body.ErrorCode !== 0)) {
        throw new Error(`postmark: ${body?.Message ?? `HTTP ${response.status}`}`);
      }
      return { id: body?.MessageID };
    },
  };
}
