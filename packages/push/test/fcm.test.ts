// FCM client: the RS256 OAuth exchange, the message endpoint, and dead-token detection.

import { describe, expect, test } from "bun:test";
import { createFcmClient, fcmConfigFromJson, type FcmConfig } from "../src/fcm";

async function testConfig(): Promise<{ pair: CryptoKeyPair; config: FcmConfig }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
  return {
    pair,
    config: { credentials: { project_id: "test-project", client_email: "push@test-project.iam.gserviceaccount.com", private_key: pem } },
  };
}

const decodeB64url = (part: string) => JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));

describe("fcm", () => {
  test("credentials are validated", () => {
    expect(() => fcmConfigFromJson("not json")).toThrow("not valid JSON");
    expect(() => fcmConfigFromJson(JSON.stringify({ client_email: "a@b" }))).toThrow("private_key");
    expect(fcmConfigFromJson(JSON.stringify({ client_email: "a@b", private_key: "-----BEGIN x" })).credentials.client_email).toBe("a@b");
  });

  test("exchanges a verifiable JWT for a token and sends to the project endpoint", async () => {
    const { pair, config } = await testConfig();
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    let oauthCalls = 0;
    const client = createFcmClient(config, {
      fetchImpl: (async (url: any, init: any) => {
        calls.push({ url, headers: init.headers, body: init.body as string });
        if (String(url).includes("oauth2")) {
          oauthCalls++;
          const assertion = new URLSearchParams(init.body).get("assertion") as string;
          const [header, claims, signature] = assertion.split(".") as [string, string, string];
          expect(JSON.parse(atob(header))).toEqual({ alg: "RS256", typ: "JWT" });
          const decoded = decodeB64url(claims);
          expect(decoded.iss).toBe("push@test-project.iam.gserviceaccount.com");
          expect(decoded.scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
          expect(decoded.aud).toBe("https://oauth2.googleapis.com/token");
          expect(decoded.exp - decoded.iat).toBe(3600);
          const raw = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/") + "=="), (c) => c.charCodeAt(0));
          expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, raw, new TextEncoder().encode(`${header}.${claims}`))).toBe(true);
          return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
        }
        return new Response(JSON.stringify({ name: "projects/test-project/messages/1" }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const result = await client.send({ token: "tok", notification: { title: "Hi", body: "there" }, data: { screenId: "s1" } });
    expect(result).toEqual({ ok: true });
    const send = calls.find((call) => call.url.includes("messages:send"))!;
    expect(send.url).toBe("https://fcm.googleapis.com/v1/projects/test-project/messages:send");
    expect(send.headers.authorization).toBe("Bearer ya29.test");
    expect(JSON.parse(send.body).message).toEqual({ token: "tok", notification: { title: "Hi", body: "there" }, data: { screenId: "s1" } });

    // The access token is cached: a second send does not re-authenticate.
    await client.send({ token: "tok2" });
    expect(oauthCalls).toBe(1);
  });

  test("dead tokens are reported so the registry can forget them", async () => {
    const { config } = await testConfig();
    const responding = (status: number, message: string) =>
      createFcmClient(config, {
        fetchImpl: (async (url: any) =>
          String(url).includes("oauth2")
            ? new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 })
            : new Response(JSON.stringify({ error: { message } }), { status })) as unknown as typeof fetch,
      });
    expect(await responding(404, "Requested entity was not found.").send({ token: "t" })).toMatchObject({ ok: false, dead: true });
    expect(await responding(410, "Unregistered.").send({ token: "t" })).toMatchObject({ dead: true });
    expect(await responding(400, "The registration token is not valid.").send({ token: "t" })).toMatchObject({ dead: true });
    expect(await responding(429, "Resource exhausted.").send({ token: "t" })).toMatchObject({ ok: false, dead: false });
  });
});
