// Firebase Cloud Messaging over HTTP v1: an RS256 service-account JWT buys an
// OAuth token, the token authorizes sends against one project. Same zero-
// dependency shape as the APNs client, so the two route interchangeably.

export type FcmServiceAccount = {
  project_id?: string;
  client_email: string;
  private_key: string;
};

export type FcmConfig = {
  credentials: FcmServiceAccount;
  /** Defaults to the credentials' `project_id`. */
  projectId?: string;
};

export type FcmMessage = {
  token: string;
  notification?: { title?: string; body?: string };
  /** Custom keys; values are stringified, as FCM requires. */
  data?: Record<string, string>;
  android?: { priority?: "normal" | "high"; collapseKey?: string };
  apns?: { payload?: object };
};

export type FcmResult = { ok: true } | { ok: false; status: number; reason: string; dead: boolean };

const OAUTH_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

/** Parses and validates the service-account JSON file's contents. */
export function fcmConfigFromJson(json: string): FcmConfig {
  let parsed: FcmServiceAccount;
  try {
    parsed = JSON.parse(json) as FcmServiceAccount;
  } catch {
    throw new Error("fcm credentials are not valid JSON.");
  }
  if (typeof parsed?.client_email !== "string" || typeof parsed?.private_key !== "string") {
    throw new Error("fcm credentials need client_email and private_key.");
  }
  return { credentials: parsed };
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

export function createFcmClient(config: FcmConfig, options: { fetchImpl?: typeof fetch } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const projectId = config.projectId ?? config.credentials.project_id ?? "";
  let cached: { token: string; issuedAt: number } | null = null;

  /** Exchanges a signed JWT assertion for an access token; Google allows the JWT for an hour. */
  async function accessToken(now = Date.now()): Promise<string> {
    if (cached && now - cached.issuedAt < 50 * 60 * 1000) return cached.token;
    const issuedAt = Math.floor(now / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({
        iss: config.credentials.client_email,
        scope: SCOPE,
        aud: OAUTH_URL,
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    );
    const key = await crypto.subtle.importKey("pkcs8", pemToDer(config.credentials.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const assertion = `${header}.${claims}.${base64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)))}`;
    const response = await fetchImpl(OAUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    const body = (await response.json().catch(() => null)) as { access_token?: string; error_description?: string } | null;
    if (!response.ok || !body?.access_token) {
      throw new Error(`fcm auth failed: ${body?.error_description ?? response.status}`);
    }
    cached = { token: body.access_token, issuedAt: now };
    return body.access_token;
  }

  /** Sends one message. `dead` on a failed result means the token should be forgotten. */
  async function send(message: FcmMessage): Promise<FcmResult> {
    if (!projectId) return { ok: false, status: 0, reason: "no fcm project id", dead: false };
    const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          token: message.token,
          ...(message.notification ? { notification: message.notification } : {}),
          ...(message.data ? { data: Object.fromEntries(Object.entries(message.data).map(([k, v]) => [k, String(v)])) } : {}),
          ...(message.android ? { android: message.android } : {}),
          ...(message.apns ? { apns: message.apns } : {}),
        },
      }),
    });
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    const reason = body?.error?.message ?? `HTTP ${response.status}`;
    const dead = response.status === 404 || response.status === 410 || /not.*(registered|valid)|unregistered|invalid registration/i.test(reason);
    return { ok: false, status: response.status, reason, dead };
  }

  return { send, resetAccessTokenCache: () => (cached = null) };
}

export type FcmClient = ReturnType<typeof createFcmClient>;
