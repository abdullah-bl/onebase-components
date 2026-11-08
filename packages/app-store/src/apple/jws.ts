/**
 * Verifies the JWS documents the App Store signs: StoreKit 2 transactions and
 * App Store Server Notifications V2. The `x5c` header carries the chain
 * (leaf, intermediate, root). We pin the root to Apple Root CA - G3, check each
 * signature in the chain and Apple's marker extensions, then check the payload
 * signature with the leaf key. WebCrypto only, so it runs on Workers and Bun.
 *
 * Extracted from the ShaSha app's `lib/apple/jws.ts` (same logic, tested there
 * and here against openssl-generated chains).
 */
import { APPLE_ROOT_CA_G3_BASE64 } from "./root-ca";

/** Marks a leaf certificate Apple issued for signing App Store receipts. */
const OID_LEAF_MARKER = "1.2.840.113635.100.6.11.1";
/** Marks Apple's Worldwide Developer Relations intermediate. */
const OID_INTERMEDIATE_MARKER = "1.2.840.113635.100.6.2.1";

const OID_EC_PUBLIC_KEY_P256 = "1.2.840.10045.3.1.7";
const OID_EC_PUBLIC_KEY_P384 = "1.3.132.0.34";
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_ECDSA_SHA384 = "1.2.840.10045.4.3.3";

export class AppleJwsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleJwsError";
  }
}

export function base64Decode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ─── Minimal DER reader ────────────────────────────────────────────────────

type Tlv = { tag: number; start: number; valueStart: number; end: number };

function readTlv(bytes: Uint8Array, offset: number): Tlv {
  if (offset + 2 > bytes.length) throw new AppleJwsError("truncated certificate");
  const tag = bytes[offset] as number;
  let length = bytes[offset + 1] as number;
  let valueStart = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new AppleJwsError("unsupported certificate length");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + (bytes[valueStart + i] as number);
    valueStart += count;
  }
  const end = valueStart + length;
  if (end > bytes.length) throw new AppleJwsError("truncated certificate");
  return { tag, start: offset, valueStart, end };
}

function children(bytes: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let offset = parent.valueStart;
  while (offset < parent.end) {
    const child = readTlv(bytes, offset);
    out.push(child);
    offset = child.end;
  }
  return out;
}

function decodeOid(bytes: Uint8Array, tlv: Tlv): string {
  const parts: number[] = [];
  let value = 0;
  let first = true;
  for (let i = tlv.valueStart; i < tlv.end; i++) {
    const byte = bytes[i] as number;
    value = value * 128 + (byte & 0x7f);
    if (byte & 0x80) continue;
    if (first) {
      const head = Math.min(Math.floor(value / 40), 2);
      parts.push(head, value - head * 40);
      first = false;
    } else {
      parts.push(value);
    }
    value = 0;
  }
  return parts.join(".");
}

function decodeTime(bytes: Uint8Array, tlv: Tlv): number {
  const text = new TextDecoder().decode(bytes.subarray(tlv.valueStart, tlv.end));
  const match =
    tlv.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (!match) throw new AppleJwsError("unsupported certificate date");
  let year = Number(match[1]);
  if (tlv.tag === 0x17) year += year >= 50 ? 1900 : 2000;
  return Date.UTC(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
}

type Certificate = {
  tbs: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  spki: Uint8Array;
  curve: "P-256" | "P-384";
  signatureAlgorithm: string;
  signature: Uint8Array;
  notBefore: number;
  notAfter: number;
  extensions: Set<string>;
};

function parseCertificate(der: Uint8Array): Certificate {
  const cert = readTlv(der, 0);
  if (cert.tag !== 0x30) throw new AppleJwsError("invalid certificate");
  const [tbsTlv, algTlv, sigTlv] = children(der, cert);
  if (!tbsTlv || !algTlv || !sigTlv) throw new AppleJwsError("invalid certificate");

  const algChildren = children(der, algTlv);
  const algOid = algChildren[0];
  if (!algOid) throw new AppleJwsError("invalid certificate");
  const signatureAlgorithm = decodeOid(der, algOid);

  const fields = children(der, tbsTlv);
  let index = 0;
  if (fields[0]?.tag === 0xa0) index++; // version
  index++; // serial
  index++; // signature algorithm
  const issuer = fields[index++];
  const validity = fields[index++];
  const subject = fields[index++];
  const spki = fields[index++];
  if (!issuer || !validity || !subject || !spki) throw new AppleJwsError("invalid certificate");

  const [notBefore, notAfter] = children(der, validity);
  if (!notBefore || !notAfter) throw new AppleJwsError("invalid certificate");

  const spkiChildren = children(der, spki);
  const keyAlg = spkiChildren[0] ? children(der, spkiChildren[0]) : [];
  const curveOid = keyAlg[1] ? decodeOid(der, keyAlg[1]) : "";
  const curve = curveOid === OID_EC_PUBLIC_KEY_P256 ? "P-256" : curveOid === OID_EC_PUBLIC_KEY_P384 ? "P-384" : null;
  if (!curve) throw new AppleJwsError("unsupported certificate key");

  const extensions = new Set<string>();
  const extensionBlock = fields.slice(index).find((field) => field.tag === 0xa3);
  if (extensionBlock) {
    const list = children(der, extensionBlock)[0];
    if (list) {
      for (const extension of children(der, list)) {
        const oid = children(der, extension)[0];
        if (oid) extensions.add(decodeOid(der, oid));
      }
    }
  }

  if (sigTlv.tag !== 0x03) throw new AppleJwsError("invalid certificate");
  return {
    tbs: der.subarray(tbsTlv.start, tbsTlv.end),
    issuer: der.subarray(issuer.start, issuer.end),
    subject: der.subarray(subject.start, subject.end),
    spki: der.subarray(spki.start, spki.end),
    curve,
    signatureAlgorithm,
    signature: der.subarray(sigTlv.valueStart + 1, sigTlv.end),
    notBefore: decodeTime(der, notBefore),
    notAfter: decodeTime(der, notAfter),
    extensions,
  };
}

/** Turns a DER ECDSA signature into the fixed-width r||s form WebCrypto expects. */
function ecdsaDerToRaw(der: Uint8Array, size: number): Uint8Array {
  const sequence = readTlv(der, 0);
  const [r, s] = children(der, sequence);
  if (sequence.tag !== 0x30 || !r || !s) throw new AppleJwsError("invalid signature");
  const out = new Uint8Array(size * 2);
  for (const [integer, offset] of [
    [r, 0],
    [s, size],
  ] as const) {
    let value = der.subarray(integer.valueStart, integer.end);
    while (value.length > size && value[0] === 0) value = value.subarray(1);
    if (value.length > size) throw new AppleJwsError("invalid signature");
    out.set(value, offset + size - value.length);
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function importKey(cert: Certificate, usage: "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", cert.spki as any, { name: "ECDSA", namedCurve: cert.curve }, false, [usage]);
}

async function certificateSignedBy(child: Certificate, parent: Certificate): Promise<boolean> {
  if (!sameBytes(child.issuer, parent.subject)) return false;
  const hash =
    child.signatureAlgorithm === OID_ECDSA_SHA256 ? "SHA-256" : child.signatureAlgorithm === OID_ECDSA_SHA384 ? "SHA-384" : null;
  if (!hash) return false;
  const size = parent.curve === "P-256" ? 32 : 48;
  const key = await importKey(parent, "verify");
  return crypto.subtle.verify({ name: "ECDSA", hash }, key, ecdsaDerToRaw(child.signature, size) as any, child.tbs as any);
}

export type VerifyOptions = {
  /** The pinned root. Tests pass their own; production uses Apple Root CA - G3. */
  root?: Uint8Array;
  /** Certificates must be valid at this time (ms). Defaults to now. */
  at?: number;
  /** Skip Apple's marker extension check. Tests only. */
  skipMarkers?: boolean;
};

/** Checks the chain and returns the leaf, or throws. */
async function verifyChain(chain: Uint8Array[], options: VerifyOptions): Promise<Certificate> {
  if (chain.length !== 3) throw new AppleJwsError("unexpected certificate chain");
  const root = options.root ?? base64Decode(APPLE_ROOT_CA_G3_BASE64);
  if (!sameBytes(chain[2] as any, root)) throw new AppleJwsError("untrusted root");

  const [leaf, intermediate, rootCert] = chain.map(parseCertificate) as [Certificate, Certificate, Certificate];
  const at = options.at ?? Date.now();
  for (const cert of [leaf, intermediate, rootCert]) {
    if (at < cert.notBefore || at > cert.notAfter) {
      throw new AppleJwsError("certificate is not valid at signing time");
    }
  }
  if (!options.skipMarkers) {
    if (!leaf.extensions.has(OID_LEAF_MARKER)) throw new AppleJwsError("not an App Store leaf");
    if (!intermediate.extensions.has(OID_INTERMEDIATE_MARKER)) {
      throw new AppleJwsError("not an App Store intermediate");
    }
  }
  if (!(await certificateSignedBy(leaf, intermediate))) throw new AppleJwsError("bad leaf signature");
  if (!(await certificateSignedBy(intermediate, rootCert))) {
    throw new AppleJwsError("bad intermediate signature");
  }
  return leaf;
}

function decodeJson<T>(part: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64Decode(part))) as T;
  } catch {
    throw new AppleJwsError("invalid JWS");
  }
}

/** Reads a JWS payload without trusting it. Use only to find the signing time. */
function peekPayload(jws: string): Record<string, unknown> {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new AppleJwsError("invalid JWS");
  return decodeJson<Record<string, unknown>>(parts[1] as string);
}

/**
 * Verifies an App Store signed JWS and returns its payload. Certificates are
 * checked at the payload's own signed time, so a long-lived purchase still
 * verifies after Apple has rotated the leaf certificate.
 */
export async function verifyAppleJws<T extends object>(jws: string, options: VerifyOptions = {}): Promise<T> {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new AppleJwsError("invalid JWS");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeJson<{ alg?: string; x5c?: unknown }>(headerPart);
  if (header.alg !== "ES256") throw new AppleJwsError("unsupported JWS algorithm");
  if (!Array.isArray(header.x5c) || !header.x5c.every((item) => typeof item === "string")) {
    throw new AppleJwsError("missing certificate chain");
  }

  const signedDate = Number(peekPayload(jws).signedDate);
  const now = Date.now();
  const at = options.at ?? (Number.isFinite(signedDate) && signedDate > 0 ? Math.min(signedDate, now) : now);
  const chain = (header.x5c as string[]).map((cert) => base64Decode(cert));
  const leaf = await verifyChain(chain, { ...options, at });

  const key = await importKey(leaf, "verify");
  const signature = base64Decode(signaturePart);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature as any,
    new TextEncoder().encode(`${headerPart}.${payloadPart}`) as any,
  );
  if (!valid) throw new AppleJwsError("bad JWS signature");
  return decodeJson<T>(payloadPart);
}
