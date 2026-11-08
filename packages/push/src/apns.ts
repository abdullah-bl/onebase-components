// Apple Push Notification service over HTTP/2, signed with a .p8 key (ES256 JWT).
// Zero dependencies — WebCrypto and fetch — so it runs on Bun and Workers.
// Ported from the ShaSha app's `lib/apns.ts`; the module-level token cache became
// a per-client cache so several apps can sign in one process.

export type ApnsEnvironment = "sandbox" | "production";

export type ApnsConfig = {
  keyId: string;
  teamId: string;
  /** PKCS#8 PEM contents of the AuthKey_XXXX.p8 file. */
  privateKey: string;
  /** The app's bundle id. */
  topic: string;
};

export type ApnsSendOptions = {
  /** 10 sends immediately, 5 conserves battery (default 10). */
  priority?: number;
  /** A newer push with the same id replaces the one still on the lock screen. */
  collapseId?: string;
  /** When Apple may discard the push (default one hour out). */
  expirationAtMs?: number;
  pushType?: "alert" | "background";
};

export type ApnsResult = { ok: true } | { ok: false; status: number; reason: string; dead: boolean };

const HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/** Builds the config from the usual environment variables, or null when they are absent. */
export function apnsConfigFromEnv(env: Record<string, string | undefined> = process.env): ApnsConfig | null {
  const keyId = env.APNS_KEY_ID;
  const teamId = env.APNS_TEAM_ID;
  const privateKey = env.APNS_PRIVATE_KEY;
  if (!keyId || !teamId || !privateKey) return null;
  return {
    keyId,
    teamId,
    // Secrets are often stored with literal "\n" sequences.
    privateKey: privateKey.replace(/\\n/g, "\n"),
    topic: env.APNS_TOPIC ?? "",
  };
}

function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function createApnsClient(config: ApnsConfig, options: { fetchImpl?: typeof fetch } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  let cached: { token: string; issuedAt: number } | null = null;

  /** Apple rejects provider tokens older than 60 minutes, and ones refreshed more than every 20. */
  async function providerToken(now = Date.now()): Promise<string> {
    if (cached && now - cached.issuedAt < 40 * 60 * 1000) return cached.token;
    const issuedAt = Math.floor(now / 1000);
    const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
    const claims = base64url(JSON.stringify({ iss: config.teamId, iat: issuedAt }));
    const key = await crypto.subtle.importKey("pkcs8", pemToDer(config.privateKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    // WebCrypto returns the raw r||s form that JWT ES256 expects.
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${claims}`));
    const token = `${header}.${claims}.${base64url(signature)}`;
    cached = { token, issuedAt: now };
    return token;
  }

  /** Sends one push. `dead` on a failed result means the token should be forgotten. */
  async function send(deviceToken: string, environment: ApnsEnvironment, payload: object, sendOpts: ApnsSendOptions = {}): Promise<ApnsResult> {
    const response = await fetchImpl(`${HOSTS[environment]}/3/device/${deviceToken}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${await providerToken()}`,
        "apns-topic": config.topic,
        "apns-push-type": sendOpts.pushType ?? "alert",
        "apns-priority": String(sendOpts.priority ?? 10),
        ...(sendOpts.collapseId ? { "apns-collapse-id": sendOpts.collapseId.slice(0, 64) } : {}),
        "apns-expiration": String(Math.floor((sendOpts.expirationAtMs ?? Date.now() + 60 * 60_000) / 1000)),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as { reason?: string } | null;
    const reason = body?.reason ?? "Unknown";
    // 410 = token no longer active. BadDeviceToken / DeviceTokenNotForTopic = wrong environment or app.
    const dead = response.status === 410 || response.status === 404 || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic";
    return { ok: false, status: response.status, reason, dead };
  }

  return { send, providerToken, resetProviderTokenCache: () => (cached = null) };
}

export type ApnsClient = ReturnType<typeof createApnsClient>;
