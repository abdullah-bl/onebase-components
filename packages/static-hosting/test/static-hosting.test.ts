// Static hosting end to end: the deploy client talks to the component's HTTP routes inside a
// real runtime (fetch is routed into it), then requests are served from what was published.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineComponents } from "onebase/components";
import { defineSchema } from "onebase/server";
import { cacheControlFor, etagMatches, isHashedAsset, normalizeSitePath, requestSitePath, staticHosting, CHUNK_BYTES } from "../src/index";
import { deploySite, rollbackSite, siteStatus } from "../src/deploy";
import { openRuntime, type TestApp } from "../../../test/app";

const TOKEN = "test-token-0123456789abcdef";
const BASE = "http://site.test/site";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function open(extra: Record<string, unknown> = {}) {
  const app = await openRuntime({
    schema: defineSchema({}),
    modules: {},
    components: defineComponents({ site: staticHosting({ deployToken: TOKEN, httpPrefix: "/site", keepDeployments: 1, ...extra } as any) as any }),
  });
  cleanups.push(() => app.close());
  return app;
}

/** fetch, answered by the runtime's HTTP routes. */
const fetchVia = (app: TestApp) => async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input as string, init);
  const route = app.runtime.lookupHttp(req.method, new URL(req.url).pathname);
  if (!route) return new Response("Not found", { status: 404 });
  return app.runtime.runHttpAction(route.handler.handler as any, req, null, route.mount);
};

function site(files: Record<string, string | Uint8Array>) {
  const dir = mkdtempSync(join(tmpdir(), "static-site-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const deploy = (app: TestApp, dir: string, label?: string) => deploySite({ url: BASE, token: TOKEN, dir, label, fetch: fetchVia(app) as any });
const get = (app: TestApp, path: string, headers: Record<string, string> = {}) => fetchVia(app)(`http://site.test${path}`, { headers });

describe("static hosting", () => {
  test("shows a setup page before the first deploy", async () => {
    const app = await open();
    const res = await get(app, "/site/");
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("deploys and serves files with types, cache headers and ETags", async () => {
    const app = await open();
    const dir = site({
      "index.html": "<h1>home</h1>",
      "about/index.html": "<h1>about</h1>",
      "assets/index-B71cUw87.js": "console.log(1)",
      "logo.svg": "<svg/>",
    });
    const result = await deploy(app, dir, "v1");
    expect(result).toMatchObject({ files: 4, uploaded: 4 });

    const home = await get(app, "/site/");
    expect(home.status).toBe(200);
    expect(await home.text()).toBe("<h1>home</h1>");
    expect(home.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(home.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(home.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const js = await get(app, "/site/assets/index-B71cUw87.js");
    expect(await js.text()).toBe("console.log(1)");
    expect(js.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");

    expect(await (await get(app, "/site/about")).text()).toBe("<h1>about</h1>");
    expect(await (await get(app, "/site/about/")).text()).toBe("<h1>about</h1>");
    expect((await get(app, "/site/logo.svg")).headers.get("Content-Type")).toBe("image/svg+xml");

    const etag = home.headers.get("ETag")!;
    const again = await get(app, "/site/", { "If-None-Match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  test("SPA fallback, missing assets, and 404.html", async () => {
    const app = await open();
    await deploy(app, site({ "index.html": "app shell" }));
    const deep = await get(app, "/site/users/42");
    expect(deep.status).toBe(200);
    expect(await deep.text()).toBe("app shell");
    // A missing file with an extension is a real 404, not the shell.
    expect((await get(app, "/site/missing.js")).status).toBe(404);

    await deploy(app, site({ "index.html": "app shell", "404.html": "custom 404" }));
    const missing = await get(app, "/site/missing.png");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("custom 404");
  });

  test("spaFallback: false 404s unknown routes", async () => {
    const app = await open({ spaFallback: false });
    await deploy(app, site({ "index.html": "home" }));
    expect((await get(app, "/site/users/42")).status).toBe(404);
    expect((await get(app, "/site/")).status).toBe(200);
  });

  test("re-deploys upload only changed content, then swap atomically", async () => {
    const app = await open();
    const first = await deploy(app, site({ "index.html": "v1", "big.txt": "same", "a.css": "a" }));
    expect(first.uploaded).toBe(3);
    const second = await deploy(app, site({ "index.html": "v2", "big.txt": "same", "a.css": "a" }));
    expect(second.uploaded).toBe(1);
    expect(await (await get(app, "/site/")).text()).toBe("v2");
    const current = (await app.runtime.runQuery("components/site:current", {}, { allowInternal: true } as any)).value as any;
    expect(current.deploymentId).toBe(second.deploymentId);
  });

  test("an unpublished deployment isn't served", async () => {
    const app = await open();
    await deploy(app, site({ "index.html": "live" }));
    const res = await fetchVia(app)(`${BASE}/_deploy/begin`, {
      method: "POST",
      headers: { "X-Deploy-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ files: [{ path: "/index.html", hash: "a".repeat(64), size: 4 }] }),
    });
    const { deploymentId } = (await res.json()) as any;
    expect(await (await get(app, "/site/")).text()).toBe("live");
    // Committing before the content arrives is refused.
    const commit = await fetchVia(app)(`${BASE}/_deploy/commit`, { method: "POST", headers: { "X-Deploy-Token": TOKEN }, body: JSON.stringify({ deploymentId }) });
    expect(commit.status).toBe(400);
    expect(((await commit.json()) as any).error).toContain("not uploaded yet");
  });

  test("uploads are checked against their hash and size", async () => {
    const app = await open();
    const hash = "b".repeat(64);
    await fetchVia(app)(`${BASE}/_deploy/begin`, {
      method: "POST",
      headers: { "X-Deploy-Token": TOKEN },
      body: JSON.stringify({ files: [{ path: "/index.html", hash, size: 3 }] }),
    });
    const bad = await fetchVia(app)(`${BASE}/_deploy/blob/${hash}`, { method: "PUT", headers: { "X-Deploy-Token": TOKEN }, body: "abc" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toContain("doesn't match");
    // Content no deployment asked for is refused.
    const stray = await fetchVia(app)(`${BASE}/_deploy/blob/${"c".repeat(64)}`, { method: "PUT", headers: { "X-Deploy-Token": TOKEN }, body: "x" });
    expect(stray.status).toBe(400);
  });

  test("deploy routes need the token", async () => {
    const app = await open();
    expect((await fetchVia(app)(`${BASE}/_deploy/status`)).status).toBe(401);
    expect((await fetchVia(app)(`${BASE}/_deploy/status`, { headers: { "X-Deploy-Token": "wrong-token-0123456789" } })).status).toBe(401);
    expect(deploySite({ url: BASE, token: "nope", dir: site({ "index.html": "x" }), fetch: fetchVia(app) as any })).rejects.toThrow("401");
  });

  test("without a deployToken, deploys are off", async () => {
    const app = await open({ deployToken: undefined });
    expect((await fetchVia(app)(`${BASE}/_deploy/status`, { headers: { "X-Deploy-Token": TOKEN } })).status).toBe(403);
  });

  test("rollback restores the previous deployment; gc keeps only keepDeployments", async () => {
    const app = await open();
    const v1 = await deploy(app, site({ "index.html": "v1", "old.txt": "only in v1" }), "v1");
    const v2 = await deploy(app, site({ "index.html": "v2" }), "v2");
    const back = await rollbackSite({ url: BASE, token: TOKEN, fetch: fetchVia(app) as any });
    expect(back.deploymentId).toBe(v1.deploymentId);
    expect(await (await get(app, "/site/")).text()).toBe("v1");
    expect(await (await get(app, "/site/old.txt")).text()).toBe("only in v1");

    // Two more deploys push v1 and v2 out (keepDeployments: 1); gc drops their unique content.
    await deploy(app, site({ "index.html": "v3" }));
    await deploy(app, site({ "index.html": "v4" }));
    // gc is scheduled after each publish; run it here too so the test doesn't race the scheduler.
    await app.runtime.runMutation("components/site:gc", {}, { allowInternal: true, source: "dashboard" } as any);
    const status = (await siteStatus({ url: BASE, token: TOKEN, fetch: fetchVia(app) as any })) as any;
    expect(status.current.label).toBeNull();
    const ids = status.deployments.map((d: any) => d.deploymentId);
    expect(ids).not.toContain(v1.deploymentId);
    expect(ids).not.toContain(v2.deploymentId);
    expect(status.deployments).toHaveLength(2); // live + one kept
    await expect(rollbackSite({ url: BASE, token: TOKEN, deploymentId: v1.deploymentId, fetch: fetchVia(app) as any })).rejects.toThrow();
  });

  test("large files are chunked and streamed", async () => {
    const app = await open();
    const big = new Uint8Array(CHUNK_BYTES * 2 + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    await deploy(app, site({ "index.html": "x", "video.bin": big }));
    const res = await get(app, "/site/video.bin");
    expect(res.headers.get("Content-Length")).toBe(String(big.length));
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.length).toBe(big.length);
    expect(Buffer.compare(Buffer.from(got), Buffer.from(big))).toBe(0);
  });

  test("rejects bad manifests", async () => {
    const app = await open();
    const begin = (files: unknown[]) =>
      fetchVia(app)(`${BASE}/_deploy/begin`, { method: "POST", headers: { "X-Deploy-Token": TOKEN }, body: JSON.stringify({ files }) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
    const h = "d".repeat(64);
    expect((await begin([])).status).toBe(400);
    expect((await begin([{ path: "/../etc/passwd", hash: h, size: 1 }])).body.error).toContain("Invalid file path");
    expect((await begin([{ path: "/a", hash: h, size: 1 }, { path: "/a", hash: h, size: 1 }])).body.error).toContain("Duplicate");
    expect((await begin([{ path: "/a", hash: "nothex", size: 1 }])).body.error).toContain("SHA-256");
  });
});

describe("http helpers", () => {
  test("hashed asset detection", () => {
    expect(isHashedAsset("/assets/index-B71cUw87.js")).toBe(true);
    expect(isHashedAsset("/static/js/main.3f9a1c2e.js")).toBe(true);
    expect(isHashedAsset("/privacy-policy.html")).toBe(false);
    expect(isHashedAsset("/background.png")).toBe(false);
    expect(cacheControlFor("/fonts/inter.woff2", ["/fonts/"])).toContain("immutable");
  });

  test("etag matching", () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc", "x"', '"abc"')).toBe(true);
    expect(etagMatches("*", '"abc"')).toBe(true);
    expect(etagMatches('"x"', '"abc"')).toBe(false);
    expect(etagMatches(null, '"abc"')).toBe(false);
  });

  test("paths", () => {
    expect(normalizeSitePath("/a/b.js")).toBe("/a/b.js");
    expect(normalizeSitePath("a.js")).toBeNull();
    expect(normalizeSitePath("/a//b")).toBeNull();
    expect(normalizeSitePath("/a/../b")).toBeNull();
    expect(requestSitePath("/site/a%20b.txt", "/site")).toBe("/a b.txt");
    expect(requestSitePath("/site", "/site")).toBe("/");
    expect(requestSitePath("/other", "/site")).toBeNull();
    expect(requestSitePath("/site/%E0%A4%A", "/site")).toBeNull();
    expect(requestSitePath("/x", "")).toBe("/x");
  });
});
