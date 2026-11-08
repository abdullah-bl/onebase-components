// Transports against fake fetches, and the sendCode helper end to end. SMTP is
// covered by its guard: nodemailer is an optional dependency and is not installed
// here, so the helpful error is the contract.

import { describe, expect, test } from "bun:test";
import { createSendCode, createPostmark, createResend, createSmtp, render } from "../src/index";
import type { EmailMessage, Transport } from "../src/types";

function fakeTransport(): { transport: Transport; sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    transport: {
      name: "fake",
      send: async (message) => {
        sent.push(message);
        return { id: "fake-1" };
      },
    },
  };
}

describe("transports", () => {
  test("resend posts to the API with a bearer token", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const resend = createResend({
      apiKey: "re_test",
      fetchImpl: (async (url: any, init: any) => {
        calls.push({ url, headers: init.headers, body: init.body as string });
        return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const result = await resend.send({
      from: "App <no-reply@app.com>",
      to: ["a@x.com", "b@x.com"],
      subject: "Hi",
      html: "<p>Hi</p>",
      replyTo: "support@app.com",
    });
    expect(result).toEqual({ id: "email-1" });
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(calls[0]?.headers.authorization).toBe("Bearer re_test");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      from: "App <no-reply@app.com>",
      to: ["a@x.com", "b@x.com"],
      subject: "Hi",
      html: "<p>Hi</p>",
      reply_to: "support@app.com",
    });

    const failing = createResend({
      apiKey: "re_test",
      fetchImpl: (async () => new Response(JSON.stringify({ message: "invalid from" }), { status: 422 })) as unknown as typeof fetch,
    });
    await expect(failing.send({ from: "x", to: "y", subject: "s" })).rejects.toThrow("invalid from");
  });

  test("postmark posts with its token header and reports API errors", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const postmark = createPostmark({
      serverToken: "pm_test",
      fetchImpl: (async (url: any, init: any) => {
        calls.push({ url, headers: init.headers, body: init.body as string });
        return new Response(JSON.stringify({ MessageID: "pm-1", ErrorCode: 0 }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const result = await postmark.send({ from: "App <no-reply@app.com>", to: ["a@x.com", "b@x.com"], subject: "Hi", text: "Hi" });
    expect(result).toEqual({ id: "pm-1" });
    expect(calls[0]?.url).toBe("https://api.postmarkapp.com/email");
    expect(calls[0]?.headers["X-Postmark-Server-Token"]).toBe("pm_test");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.To).toBe("a@x.com, b@x.com");
    expect(body.TextBody).toBe("Hi");

    const failing = createPostmark({
      serverToken: "pm_test",
      fetchImpl: (async () => new Response(JSON.stringify({ ErrorCode: 300, Message: "Invalid API token" }), { status: 200 })) as unknown as typeof fetch,
    });
    await expect(failing.send({ from: "x", to: "y", subject: "s" })).rejects.toThrow("Invalid API token");
  });

  test("smtp explains the optional dependency when nodemailer is missing", async () => {
    const smtp = createSmtp({ host: "smtp.app.com", auth: { user: "u", pass: "p" } });
    await expect(smtp.send({ from: "a", to: "b", subject: "s" })).rejects.toThrow("bun add nodemailer");
  });
});

describe("sendCode", () => {
  test("renders the default templates and sends through the transport", async () => {
    const { transport, sent } = fakeTransport();
    const sendCode = createSendCode({ transport, from: "App <no-reply@app.com>" });
    await sendCode({ email: "user@x.com", code: "12345678", purpose: "verify" });
    await sendCode({ email: "user@x.com", code: "87654321", purpose: "reset" });
    expect(sent[0]).toMatchObject({
      from: "App <no-reply@app.com>",
      to: "user@x.com",
      subject: "Confirm your email",
      text: "Your confirmation code is 12345678. It expires in 15 minutes.",
    });
    expect(sent[1]?.subject).toBe("Reset your password");
    expect(sent[1]?.html).toContain("87654321");
  });

  test("custom templates interpolate", async () => {
    const { transport, sent } = fakeTransport();
    const sendCode = createSendCode({
      transport,
      from: "x@app.com",
      templates: { verify: { subject: "{{ code }} is your code" } },
    });
    await sendCode({ email: "a@x.com", code: "99999999", purpose: "verify" });
    expect(sent[0]?.subject).toBe("99999999 is your code");
    expect(sent[0]?.text).toBeUndefined();
  });

  test("render fills known keys and drops unknown ones", () => {
    expect(render("Hi {{ name }}, {{ nope }}!", { name: "Ada" })).toBe("Hi Ada, !");
  });
});
