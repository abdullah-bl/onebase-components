// Apple JWS verification, against openssl-generated chains. Ported from the ShaSha
// app's test suite.

import { beforeAll, describe, expect, test } from "bun:test";
import { AppleJwsError, base64Decode, verifyAppleJws } from "../src/apple/jws";
import { APPLE_ROOT_CA_G3_BASE64 } from "../src/apple/root-ca";
import { buildChain, signJws, type Chain } from "./chains";

let chain: Chain;
let unmarked: Chain;

beforeAll(async () => {
  chain = await buildChain({ markers: true });
  unmarked = await buildChain({ markers: false });
});

describe("Apple JWS verification", () => {
  test("accepts a payload signed through the pinned chain", async () => {
    const jws = await signJws(chain, { productId: "pro_monthly", signedDate: Date.now() });
    const payload = await verifyAppleJws<{ productId: string }>(jws, { root: chain.root });
    expect(payload.productId).toBe("pro_monthly");
  });

  test("rejects a chain that does not end at the pinned root", async () => {
    const jws = await signJws(chain, { productId: "pro_monthly" });
    await expect(verifyAppleJws(jws)).rejects.toThrow(AppleJwsError);
  });

  test("rejects a tampered payload", async () => {
    const jws = await signJws(chain, { productId: "basic_monthly", signedDate: Date.now() });
    const [header, , signature] = jws.split(".") as [string, string, string];
    const forged = Buffer.from(new TextEncoder().encode(JSON.stringify({ productId: "max_yearly", signedDate: Date.now() })))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expect(verifyAppleJws(`${header}.${forged}.${signature}`, { root: chain.root })).rejects.toThrow("bad JWS signature");
  });

  test("rejects a payload signed by a key that is not the leaf", async () => {
    const jws = await signJws(chain, { productId: "max_yearly" }, chain.otherLeafKey);
    await expect(verifyAppleJws(jws, { root: chain.root })).rejects.toThrow("bad JWS signature");
  });

  test("rejects a swapped leaf certificate", async () => {
    const swapped = [chain.x5c[1] as string, chain.x5c[1] as string, chain.x5c[2] as string];
    const jws = await signJws(chain, { productId: "max_yearly" }, undefined, swapped);
    await expect(verifyAppleJws(jws, { root: chain.root })).rejects.toThrow(AppleJwsError);
  });

  test("rejects a chain without Apple's marker extensions", async () => {
    const jws = await signJws(unmarked, { productId: "max_yearly" });
    await expect(verifyAppleJws(jws, { root: unmarked.root })).rejects.toThrow("not an App Store leaf");
  });

  test("rejects certificates outside their validity window", async () => {
    const jws = await signJws(chain, { productId: "pro_monthly", signedDate: Date.now() });
    await expect(verifyAppleJws(jws, { root: chain.root, at: Date.UTC(2100, 0, 1) })).rejects.toThrow("not valid");
  });

  test("rejects the wrong algorithm and malformed input", async () => {
    const header = Buffer.from(new TextEncoder().encode(JSON.stringify({ alg: "none" })))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expect(verifyAppleJws(`${header}.e30.`)).rejects.toThrow(AppleJwsError);
    await expect(verifyAppleJws("not-a-jws")).rejects.toThrow(AppleJwsError);
  });

  test("the pinned root is Apple Root CA - G3", async () => {
    const digest = await crypto.subtle.digest("SHA-256", base64Decode(APPLE_ROOT_CA_G3_BASE64) as any);
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe("63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179");
  });
});
