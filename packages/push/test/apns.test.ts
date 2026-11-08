// APNs client: provider JWT signing, host/headers, and dead-token detection.
// Ported from the ShaSha app's apns tests to the per-client API.

import { describe, expect, test } from "bun:test";
import { apnsConfigFromEnv, createApnsClient, type ApnsConfig } from "../src/apns";

async function testConfig(): Promise<{ pair: CryptoKeyPair; config: ApnsConfig }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
  return { pair, config: { keyId: "KEY1234567", teamId: "TEAM123456", privateKey: pem, topic: "com.test.app" } };
}

const decodeB64url = (part: string) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));

describe("apns", () => {
  test("config needs all three secrets and unescapes newlines", () => {
    expect(apnsConfigFromEnv({ APNS_KEY_ID: "k" })).toBeNull();
    const config = apnsConfigFromEnv({ APNS_KEY_ID: "k", APNS_TEAM_ID: "t", APNS_PRIVATE_KEY: "a\\nb" });
    expect(config?.privateKey).toBe("a\nb");
    expect(config?.topic).toBe("");
  });

  test("provider token is a valid ES256 JWT and is cached for 40 minutes", async () => {
    const { pair, config } = await testConfig();
    const client = createApnsClient(config);
    const token = await client.providerToken(1_000_000);
    const [header, claims, signature] = token.split(".") as [string, string, string];
    expect(decodeB64url(header)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(decodeB64url(claims).iss).toBe("TEAM123456");

    const raw = Uint8Array.from(
      atob(signature.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (signature.length % 4)) % 4)),
      (c) => c.charCodeAt(0),
    );
    expect(raw.length).toBe(64);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, raw, new TextEncoder().encode(`${header}.${claims}`))).toBe(true);

    expect(await client.providerToken(1_000_000 + 30 * 60 * 1000)).toBe(token);
    expect(await client.providerToken(1_000_000 + 41 * 60 * 1000)).not.toBe(token);
  });

  test("send targets the right host with the right headers", async () => {
    const { config } = await testConfig();
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const client = createApnsClient(config, {
      fetchImpl: (async (url: any, init: any) => {
        calls.push({ url, headers: init.headers });
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const result = await client.send("tok", "sandbox", { aps: { alert: { title: "Hi" } } }, { collapseId: "s1" });
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://api.sandbox.push.apple.com/3/device/tok");
    expect(calls[0]?.headers["apns-topic"]).toBe("com.test.app");
    expect(calls[0]?.headers["apns-collapse-id"]).toBe("s1");
    expect(calls[0]?.headers.authorization).toMatch(/^bearer ey/);
  });

  test("dead tokens are reported so the registry can forget them", async () => {
    const { config } = await testConfig();
    const responding = (status: number, reason: string) =>
      createApnsClient(config, {
        fetchImpl: (async () => new Response(JSON.stringify({ reason }), { status })) as unknown as typeof fetch,
      });
    expect(await responding(410, "Unregistered").send("tok", "production", {})).toEqual({
      ok: false,
      status: 410,
      reason: "Unregistered",
      dead: true,
    });
    expect(await responding(400, "BadDeviceToken").send("tok", "production", {})).toMatchObject({ dead: true });
    expect(await responding(429, "TooManyRequests").send("tok", "production", {})).toMatchObject({ ok: false, dead: false });
  });
});
