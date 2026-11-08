// Shared openssl-generated certificate chains for the app-store tests, shaped like
// Apple's: P-384 root and intermediate, P-256 leaf, with (or without) Apple's marker
// extensions. Ported from the ShaSha app's JWS test fixtures.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Chain = {
  root: Uint8Array;
  x5c: string[];
  leafKey: CryptoKey;
  otherLeafKey: CryptoKey;
};

function run(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["openssl", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

const b64 = (bytes: Uint8Array | ArrayBuffer) => Buffer.from(bytes as ArrayBuffer).toString("base64");
const b64url = (bytes: Uint8Array | ArrayBuffer) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function buildChain(options: { markers: boolean }): Promise<Chain> {
  const dir = mkdtempSync(join(tmpdir(), "apple-chain-"));
  writeFileSync(
    join(dir, "ext.cnf"),
    [
      "[ca]",
      "basicConstraints=critical,CA:TRUE",
      "[inter]",
      "basicConstraints=critical,CA:TRUE",
      ...(options.markers ? ["1.2.840.113635.100.6.2.1=ASN1:NULL"] : []),
      "[leaf]",
      ...(options.markers ? ["1.2.840.113635.100.6.11.1=ASN1:NULL"] : ["basicConstraints=CA:FALSE"]),
      "",
    ].join("\n"),
  );
  run(dir, ["ecparam", "-name", "secp384r1", "-genkey", "-noout", "-out", "root.key"]);
  run(dir, ["req", "-x509", "-new", "-key", "root.key", "-sha384", "-days", "3650", "-subj", "/CN=Test Root", "-extensions", "ca", "-config", "ext.cnf", "-out", "root.pem"]);
  run(dir, ["ecparam", "-name", "secp384r1", "-genkey", "-noout", "-out", "inter.key"]);
  run(dir, ["req", "-new", "-key", "inter.key", "-subj", "/CN=Test Intermediate", "-out", "inter.csr"]);
  run(dir, ["x509", "-req", "-in", "inter.csr", "-CA", "root.pem", "-CAkey", "root.key", "-CAcreateserial", "-sha384", "-days", "3650", "-extfile", "ext.cnf", "-extensions", "inter", "-out", "inter.pem"]);
  for (const name of ["leaf", "other"]) {
    run(dir, ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`]);
    run(dir, ["req", "-new", "-key", `${name}.key`, "-subj", `/CN=Test ${name}`, "-out", `${name}.csr`]);
    run(dir, ["x509", "-req", "-in", `${name}.csr`, "-CA", "inter.pem", "-CAkey", "inter.key", "-CAcreateserial", "-sha256", "-days", "3650", "-extfile", "ext.cnf", "-extensions", "leaf", "-out", `${name}.pem`]);
    run(dir, ["pkcs8", "-topk8", "-nocrypt", "-in", `${name}.key`, "-outform", "DER", "-out", `${name}.p8`]);
  }
  for (const name of ["root", "inter", "leaf"]) run(dir, ["x509", "-in", `${name}.pem`, "-outform", "DER", "-out", `${name}.der`]);

  const der = (name: string) => new Uint8Array(readFileSync(join(dir, `${name}.der`)));
  const key = async (name: string) =>
    crypto.subtle.importKey("pkcs8", readFileSync(join(dir, `${name}.p8`)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

  return {
    root: der("root"),
    x5c: [b64(der("leaf")), b64(der("inter")), b64(der("root"))],
    leafKey: await key("leaf"),
    otherLeafKey: await key("other"),
  };
}

/** Signs a payload object as an App Store JWS with the chain's leaf key. */
export async function signJws(chain: Chain, payload: object, keyOverride?: CryptoKey, x5c?: string[]): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", x5c: x5c ?? chain.x5c })));
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyOverride ?? chain.leafKey, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(signature)}`;
}
