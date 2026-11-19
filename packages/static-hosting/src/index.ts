// Static site hosting: a built frontend (Vite, Astro, Next export, plain HTML) served by
// onebase itself, next to the backend, with atomic deploys and instant rollback.
//
//   // onebase/components.ts
//   export default defineComponents({
//     site: staticHosting({ deployToken: process.env.SITE_DEPLOY_TOKEN, httpPrefix: "/app" }),
//   });
//
//   # after `vite build --base /app/`
//   ONEBASE_STATIC_TOKEN=... bunx onebase-static deploy ./dist --url https://api.example.com/app
//
// To serve at the root, mount with `httpPrefix: "/site"` (deploys go there) and add a
// catch-all to onebase/http.ts that calls `serveSite(ctx.components.site, request)`.
//
// How it stores files: components don't get ctx.storage, so file bytes live in the
// component's own tables, content-addressed by SHA-256 and split into ≤4 MiB base64
// chunks. A deploy uploads only the blobs the server doesn't already have, so re-deploying
// a site where one file changed uploads one file.
//
// Deploy protocol (all under <httpPrefix>/_deploy, X-Deploy-Token header):
//   POST begin   { files: [{ path, hash, size, contentType? }], label? } → { deploymentId, missing: [hash] }
//   PUT  blob/<hash>   raw bytes, verified against the hash
//   POST commit  { deploymentId }  → swaps the live deployment in one transaction
//   POST rollback { deploymentId? } , GET status
//
// Old deployments are kept (`keepDeployments`, default 3) for rollback; anything older,
// abandoned uploads, and blobs no deployment uses are garbage-collected in bounded batches.

import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "onebase/components";
import { defineSchema, defineTable, type DataModelFromSchema } from "onebase/server";
import { OneBaseError, v } from "onebase/values";
import { createHash, timingSafeEqual } from "node:crypto";
import { contentTypeFor, hasExtension, normalizeSitePath, serveSite as serveWith, type Resolved, type ServeOptions } from "./http";

export { cacheControlFor, contentTypeFor, etagMatches, isHashedAsset, normalizeSitePath, requestSitePath, type Resolved } from "./http";

export type StaticHostingConfig = {
  /**
   * Secret the deploy client sends as X-Deploy-Token. Without it the deploy routes answer
   * 403, so a site can only be changed through the component's functions.
   */
  deployToken?: string;
  /** Serve /index.html for unknown extensionless paths, for client-side routing (default true). */
  spaFallback?: boolean;
  /** Previous deployments kept for rollback (default 3). */
  keepDeployments?: number;
  /** Largest file a deploy may upload (default 64 MiB). */
  maxFileBytes?: number;
  /** Most files in one deployment (default 10,000). */
  maxFiles?: number;
  /** Path prefixes always served with an immutable Cache-Control, besides content-hashed names. */
  immutablePrefixes?: string[];
  /** Set from the mount's httpPrefix; where the site's own route strips its path from. */
  basePath?: string;
};

/** Raw bytes per stored chunk; base64 makes a chunk document about 5.4 MiB. */
export const CHUNK_BYTES = 4 * 2 ** 20;
const STALE_MS = 24 * 3_600_000;
const GC_BATCH = 500;

const schema = defineSchema({
  /** One stored file content, by SHA-256. `complete` once every chunk is in. */
  blobs: defineTable({
    hash: v.string(),
    size: v.number(),
    chunkCount: v.number(),
    complete: v.boolean(),
    createdAtMs: v.number(),
  })
    .index("by_hash", ["hash"])
    .index("by_complete_createdAt", ["complete", "createdAtMs"]),
  chunks: defineTable({
    hash: v.string(),
    index: v.number(),
    data: v.string(),
  }).index("by_hash_index", ["hash", "index"]),
  /** A site version. staging → live → retired; deleted when too old or abandoned. */
  deployments: defineTable({
    status: v.string(),
    label: v.optional(v.string()),
    fileCount: v.number(),
    totalBytes: v.number(),
    createdAtMs: v.number(),
    publishedAtMs: v.optional(v.number()),
  })
    .index("by_status_createdAt", ["status", "createdAtMs"])
    .index("by_status_publishedAt", ["status", "publishedAtMs"]),
  /** A deployment's manifest: which blob each path serves. */
  files: defineTable({
    deploymentId: v.string(),
    path: v.string(),
    hash: v.string(),
    contentType: v.string(),
    size: v.number(),
  })
    .index("by_deployment_path", ["deploymentId", "path"])
    .index("by_hash", ["hash"]),
  /** Singleton: the live deployment. */
  site: defineTable({
    liveDeploymentId: v.string(),
    publishedAtMs: v.number(),
  }),
});

const { query, mutation, internalQuery, internalMutation, httpAction } = componentServer<DataModelFromSchema<typeof schema>, StaticHostingConfig>();

// ---- Lookups ----

const siteRow = (ctx: any) => ctx.db.query("site").first();
const blobRow = (ctx: any, hash: string) => ctx.db.query("blobs").withIndex("by_hash", (q: any) => q.eq("hash", hash)).unique();
const fileRow = (ctx: any, deploymentId: string, path: string) =>
  ctx.db.query("files").withIndex("by_deployment_path", (q: any) => q.eq("deploymentId", deploymentId).eq("path", path)).unique();
const chunkRow = (ctx: any, hash: string, index: number) =>
  ctx.db.query("chunks").withIndex("by_hash_index", (q: any) => q.eq("hash", hash).eq("index", index)).unique();

/** A deployment by id, or null (also for an id that isn't one). */
const deploymentRow = async (ctx: any, id: string): Promise<any> => {
  try {
    const row = await ctx.db.get(id);
    return row && "status" in row && "fileCount" in row ? row : null;
  } catch {
    return null;
  }
};

const HASH = /^[0-9a-f]{64}$/;

export type DeploymentView = {
  deploymentId: string;
  status: "staging" | "live" | "retired";
  label: string | null;
  fileCount: number;
  totalBytes: number;
  createdAtMs: number;
  publishedAtMs: number | null;
};

const view = (row: any): DeploymentView => ({
  deploymentId: row._id as string,
  status: row.status,
  label: row.label ?? null,
  fileCount: row.fileCount,
  totalBytes: row.totalBytes,
  createdAtMs: row.createdAtMs,
  publishedAtMs: row.publishedAtMs ?? null,
});

// ---- Serving ----

/** The file a request path serves from the live deployment: exact, then dir/index.html, then name.html, then SPA fallback, then /404.html. */
const resolve = query({
  args: { path: v.string() },
  handler: async (ctx, { path }): Promise<Resolved> => {
    const site = await siteRow(ctx);
    if (!site) return { kind: "empty" };
    const live = site.liveDeploymentId as string;
    const find = (p: string) => fileRow(ctx, live, p);

    const candidates: string[] = [];
    if (path === "/" || path.endsWith("/")) candidates.push(path + "index.html");
    else {
      candidates.push(path);
      if (!hasExtension(path)) candidates.push(path + "/index.html", path + ".html");
    }
    let file = null;
    let status: 200 | 404 = 200;
    for (const c of candidates) if ((file = await find(c))) break;
    if (!file && !hasExtension(path) && (ctx.config.spaFallback ?? true)) file = await find("/index.html");
    if (!file) {
      file = await find("/404.html");
      status = 404;
    }
    if (!file) return path === "/" ? { kind: "empty" } : { kind: "notFound" };

    const blob = await blobRow(ctx, file.hash);
    const first = await chunkRow(ctx, file.hash, 0);
    if (!blob || !first) throw new OneBaseError(`static-hosting: content for ${file.path} is missing.`);
    return { kind: "file", status, path: file.path, hash: file.hash, contentType: file.contentType, size: file.size, chunkCount: blob.chunkCount, data: first.data };
  },
});

const chunk = query({
  args: { hash: v.string(), index: v.number() },
  handler: async (ctx, { hash, index }) => ((await chunkRow(ctx, hash, index))?.data as string | undefined) ?? null,
});

// ---- Deployment state ----

/** The live deployment, or null; a live query, so clients can show "a new version is available". */
const current = query({
  args: {},
  handler: async (ctx) => {
    const site = await siteRow(ctx);
    if (!site) return null;
    const row = await deploymentRow(ctx, site.liveDeploymentId);
    return row ? view(row) : null;
  },
});

/** Live and retired deployments, newest first. */
const deployments = query({
  args: {},
  handler: async (ctx) => {
    const rows = [
      ...(await ctx.db.query("deployments").withIndex("by_status_publishedAt", (q: any) => q.eq("status", "live")).collect()),
      ...(await ctx.db.query("deployments").withIndex("by_status_publishedAt", (q: any) => q.eq("status", "retired")).order("desc").collect()),
    ];
    return rows.map(view);
  },
});

/** Makes `row` live and retires whatever was. */
async function publish(ctx: any, row: any) {
  const now = Date.now();
  const site = await siteRow(ctx);
  if (site && site.liveDeploymentId !== (row._id as string)) {
    const old = await ctx.db.get(site.liveDeploymentId);
    if (old) await ctx.db.patch(old._id, { status: "retired" });
  }
  await ctx.db.patch(row._id, { status: "live", publishedAtMs: now });
  if (site) await ctx.db.patch(site._id, { liveDeploymentId: row._id as string, publishedAtMs: now });
  else await ctx.db.insert("site", { liveDeploymentId: row._id as string, publishedAtMs: now });
  await ctx.scheduler.runAfter(0, gc, {});
  return view({ ...row, status: "live", publishedAtMs: now });
}

/** Goes back to a retired deployment: the one given, or the most recent one before the live one. */
const rollback = mutation({
  args: { deploymentId: v.optional(v.string()) },
  handler: async (ctx, { deploymentId }) => {
    let row: any;
    if (deploymentId) {
      row = await deploymentRow(ctx, deploymentId);
      if (!row || row.status !== "retired") throw new OneBaseError(`Deployment ${deploymentId} isn't a previous deployment that can be restored.`);
    } else {
      row = await ctx.db.query("deployments").withIndex("by_status_publishedAt", (q: any) => q.eq("status", "retired")).order("desc").first();
      if (!row) throw new OneBaseError("There is no previous deployment to roll back to.");
    }
    return publish(ctx, row);
  },
});

// ---- Deploying ----

const fileArg = v.object({ path: v.string(), hash: v.string(), size: v.number(), contentType: v.optional(v.string()) });

/** Stages a manifest; returns the hashes whose content the server doesn't have yet. */
const beginDeploy = internalMutation({
  args: { files: v.array(fileArg), label: v.optional(v.string()) },
  handler: async (ctx, { files, label }) => {
    const maxFiles = ctx.config.maxFiles ?? 10_000;
    const maxFileBytes = ctx.config.maxFileBytes ?? 64 * 2 ** 20;
    if (files.length === 0) throw new OneBaseError("A deployment needs at least one file.");
    if (files.length > maxFiles) throw new OneBaseError(`A deployment can have at most ${maxFiles} files (this one has ${files.length}).`);
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const f of files) {
      const path = normalizeSitePath(f.path);
      if (!path) throw new OneBaseError(`Invalid file path "${f.path}": paths start with "/" and have no empty, "." or ".." segments.`);
      if (seen.has(path)) throw new OneBaseError(`Duplicate file path "${path}".`);
      seen.add(path);
      if (!HASH.test(f.hash)) throw new OneBaseError(`File "${path}": hash must be a lowercase hex SHA-256.`);
      if (!Number.isInteger(f.size) || f.size < 0 || f.size > maxFileBytes) throw new OneBaseError(`File "${path}" is ${f.size} bytes; the limit is ${maxFileBytes}.`);
      totalBytes += f.size;
    }
    const id = (await ctx.db.insert("deployments", { status: "staging", label, fileCount: files.length, totalBytes, createdAtMs: Date.now() })) as string;
    const missing = new Set<string>();
    for (const f of files) {
      await ctx.db.insert("files", { deploymentId: id, path: f.path, hash: f.hash, size: f.size, contentType: f.contentType || contentTypeFor(f.path) });
      const blob = await blobRow(ctx, f.hash);
      if (!blob?.complete) missing.add(f.hash);
      else if (blob.size !== f.size) throw new OneBaseError(`File "${f.path}": size ${f.size} doesn't match its content (${blob.size} bytes).`);
    }
    return { deploymentId: id, missing: [...missing] };
  },
});

/** Whether `hash` is in a staging deployment's manifest (blobs can only be uploaded for a deploy in progress), and its declared size. */
const expectedBlob = internalQuery({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) => {
    const blob = await blobRow(ctx, hash);
    if (blob?.complete) return { needed: false, size: blob.size as number };
    for (const f of await ctx.db.query("files").withIndex("by_hash", (q: any) => q.eq("hash", hash)).take(50)) {
      const dep = await deploymentRow(ctx, f.deploymentId);
      if (dep?.status === "staging") return { needed: true, size: f.size as number };
    }
    return null;
  },
});

const beginBlob = internalMutation({
  args: { hash: v.string(), size: v.number(), chunkCount: v.number() },
  handler: async (ctx, { hash, size, chunkCount }) => {
    const blob = await blobRow(ctx, hash);
    if (blob?.complete) return { done: true };
    if (blob) await ctx.db.patch(blob._id, { size, chunkCount, createdAtMs: Date.now() });
    else await ctx.db.insert("blobs", { hash, size, chunkCount, complete: false, createdAtMs: Date.now() });
    return { done: false };
  },
});

const putChunk = internalMutation({
  args: { hash: v.string(), index: v.number(), data: v.string() },
  handler: async (ctx, { hash, index, data }) => {
    const row = await chunkRow(ctx, hash, index);
    if (row) await ctx.db.patch(row._id, { data });
    else await ctx.db.insert("chunks", { hash, index, data });
    return null;
  },
});

const finishBlob = internalMutation({
  args: { hash: v.string() },
  handler: async (ctx, { hash }) => {
    const blob = await blobRow(ctx, hash);
    if (!blob) throw new OneBaseError(`Blob ${hash} was never started.`);
    for (let i = 0; i < blob.chunkCount; i++) {
      if (!(await chunkRow(ctx, hash, i))) throw new OneBaseError(`Blob ${hash} is missing chunk ${i}.`);
    }
    await ctx.db.patch(blob._id, { complete: true });
    return null;
  },
});

/** Publishes a staged deployment once all of its content has arrived. */
const commitDeploy = internalMutation({
  args: { deploymentId: v.string() },
  handler: async (ctx, { deploymentId }) => {
    const row = await deploymentRow(ctx, deploymentId);
    if (!row || row.status !== "staging") throw new OneBaseError(`Deployment ${deploymentId} isn't waiting to be published.`);
    const files = await ctx.db.query("files").withIndex("by_deployment_path", (q: any) => q.eq("deploymentId", deploymentId)).collect();
    const missing = new Set<string>();
    for (const f of files) if (!(await blobRow(ctx, f.hash))?.complete) missing.add(f.path);
    if (missing.size) throw new OneBaseError(`Content not uploaded yet for ${missing.size} file(s): ${[...missing].slice(0, 5).join(", ")}${missing.size > 5 ? ", …" : ""}.`);
    return publish(ctx, row);
  },
});

// ---- Garbage collection ----

/** Deletes a blob and its chunks if no manifest uses it any more. */
async function dropBlobIfUnused(ctx: any, hash: string) {
  if (await ctx.db.query("files").withIndex("by_hash", (q: any) => q.eq("hash", hash)).first()) return;
  const blob = await blobRow(ctx, hash);
  if (!blob) return;
  for (let i = 0; i < Math.max(blob.chunkCount, 1); i++) {
    const c = await chunkRow(ctx, hash, i);
    if (c) await ctx.db.delete(c._id);
  }
  await ctx.db.delete(blob._id);
}

/**
 * Removes deployments past `keepDeployments`, staging ones abandoned for a day, their files,
 * blobs nothing references any more, and uploads never finished. Bounded per run; it schedules
 * itself again while there's more to do.
 */
const gc = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const keep = Math.max(0, ctx.config.keepDeployments ?? 3);
    const doomed = [
      ...(await ctx.db.query("deployments").withIndex("by_status_publishedAt", (q: any) => q.eq("status", "retired")).order("desc").collect()).slice(keep),
      ...(await ctx.db.query("deployments").withIndex("by_status_createdAt", (q: any) => q.eq("status", "staging").lt("createdAtMs", now - STALE_MS)).collect()),
    ];
    let budget = GC_BATCH;
    for (const dep of doomed) {
      const files = await ctx.db.query("files").withIndex("by_deployment_path", (q: any) => q.eq("deploymentId", dep._id as string)).take(budget);
      for (const f of files) {
        await ctx.db.delete(f._id);
        await dropBlobIfUnused(ctx, f.hash);
      }
      budget -= files.length;
      if (budget <= 0) break;
      await ctx.db.delete(dep._id);
    }
    // Uploads started but never finished.
    const stale = await ctx.db.query("blobs").withIndex("by_complete_createdAt", (q: any) => q.eq("complete", false).lt("createdAtMs", now - STALE_MS)).take(Math.max(budget, 1));
    for (const b of stale) {
      for (let i = 0; i < b.chunkCount; i++) {
        const c = await chunkRow(ctx, b.hash, i);
        if (c) await ctx.db.delete(c._id);
      }
      await ctx.db.delete(b._id);
    }
    const more = budget <= 0 || stale.length >= Math.max(budget, 1);
    if (more) await ctx.scheduler.runAfter(0, gc, {});
    return { more };
  },
});

// ---- HTTP ----

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function authorized(request: Request, token: string | undefined): boolean {
  const given = request.headers.get("X-Deploy-Token");
  if (!token || !given) return false;
  // Compare digests so the comparison is constant-time whatever the lengths.
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(token).digest());
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

const errorMessage = (err: unknown) => (err instanceof OneBaseError ? String(err.data ?? err.message) : err instanceof Error ? err.message : String(err));

/** Wraps a deploy endpoint: checks the token and turns errors into JSON. */
const deployRoute = (fn: (ctx: any, request: Request) => Promise<Response>) =>
  httpAction(async (ctx, request) => {
    const config = ctx.config as StaticHostingConfig;
    if (!config.deployToken) return json({ error: "Deploys over HTTP are off: mount staticHosting with a deployToken." }, 403);
    if (!authorized(request, config.deployToken)) return json({ error: "Missing or wrong X-Deploy-Token." }, 401);
    try {
      return await fn(ctx, request);
    } catch (err) {
      return json({ error: errorMessage(err) }, 400);
    }
  });

const readJson = async (request: Request) => {
  try {
    return (await request.json()) as any;
  } catch {
    throw new OneBaseError("The request body must be JSON.");
  }
};

const basePathOf = (ctx: any) => (ctx.config as StaticHostingConfig).basePath ?? `/${ctx.component.mount}`;

const serveRoute = httpAction(async (ctx, request) =>
  serveWith(
    { resolve: (a) => ctx.runQuery(resolve, a) as Promise<Resolved>, chunk: (a) => ctx.runQuery(chunk, a) as Promise<string | null> },
    request,
    { basePath: basePathOf(ctx), immutablePrefixes: (ctx.config as StaticHostingConfig).immutablePrefixes },
  ),
);

const http = () => [
  { pathPrefix: "/", method: "GET" as const, handler: serveRoute },
  { path: "/_deploy/status", method: "GET" as const, handler: deployRoute(async (ctx) => json({ current: await ctx.runQuery(current, {}), deployments: await ctx.runQuery(deployments, {}) })) },
  {
    path: "/_deploy/begin",
    method: "POST" as const,
    handler: deployRoute(async (ctx, request) => {
      const body = await readJson(request);
      if (!Array.isArray(body?.files)) throw new OneBaseError('Body must be { files: [{ path, hash, size, contentType? }], label? }.');
      const files = body.files.map((f: any) => ({ path: String(f?.path), hash: String(f?.hash), size: Number(f?.size), ...(f?.contentType ? { contentType: String(f.contentType) } : {}) }));
      return json(await ctx.runMutation(beginDeploy, { files, ...(body.label ? { label: String(body.label) } : {}) }));
    }),
  },
  {
    pathPrefix: "/_deploy/blob/",
    method: "PUT" as const,
    handler: deployRoute(async (ctx, request) => {
      const hash = new URL(request.url).pathname.split("/").pop() ?? "";
      if (!HASH.test(hash)) throw new OneBaseError("PUT /_deploy/blob/<sha256 hex>.");
      const expected = await ctx.runQuery(expectedBlob, { hash });
      if (!expected) throw new OneBaseError(`No deployment in progress lists content ${hash}; call begin first.`);
      if (!expected.needed) return json({ hash, stored: false });
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength !== expected.size) throw new OneBaseError(`Content ${hash} should be ${expected.size} bytes; got ${bytes.byteLength}.`);
      if (sha256(bytes) !== hash) throw new OneBaseError(`Content doesn't match its hash ${hash}.`);
      const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
      if ((await ctx.runMutation(beginBlob, { hash, size: bytes.byteLength, chunkCount })).done) return json({ hash, stored: false });
      for (let i = 0; i < chunkCount; i++) {
        const data = Buffer.from(bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)).toString("base64");
        await ctx.runMutation(putChunk, { hash, index: i, data });
      }
      await ctx.runMutation(finishBlob, { hash });
      return json({ hash, stored: true });
    }),
  },
  {
    path: "/_deploy/commit",
    method: "POST" as const,
    handler: deployRoute(async (ctx, request) => {
      const { deploymentId } = await readJson(request);
      return json(await ctx.runMutation(commitDeploy, { deploymentId: String(deploymentId) }));
    }),
  },
  {
    path: "/_deploy/rollback",
    method: "POST" as const,
    handler: deployRoute(async (ctx, request) => {
      const body = request.headers.get("Content-Length") === "0" ? {} : await readJson(request).catch(() => ({}));
      return json(await ctx.runMutation(rollback, body?.deploymentId ? { deploymentId: String(body.deploymentId) } : {}));
    }),
  },
];

export const definition = defineComponent({
  name: "staticHosting",
  schema,
  functions: { resolve, chunk, current, deployments, rollback, beginDeploy, expectedBlob, beginBlob, putChunk, finishBlob, commitDeploy, gc },
  crons: () => [{ name: "gc", schedule: { hours: 1 }, fn: gc }],
  http,
  checkConfig: (config: StaticHostingConfig) => {
    if (config?.deployToken !== undefined && (typeof config.deployToken !== "string" || config.deployToken.length < 16)) {
      throw new Error("staticHosting({ deployToken }) must be a string of at least 16 characters (e.g. `openssl rand -hex 32`).");
    }
    if (config?.keepDeployments !== undefined && !(Number.isInteger(config.keepDeployments) && config.keepDeployments >= 0)) {
      throw new Error("staticHosting({ keepDeployments }) must be a whole number ≥ 0.");
    }
  },
});

// ---- Types for the app ----

export type StaticHostingApi = {
  resolve: ComponentFn<"query", (args: { path: string }) => Promise<Resolved>>;
  chunk: ComponentFn<"query", (args: { hash: string; index: number }) => Promise<string | null>>;
  current: ComponentFn<"query", (args: {}) => Promise<DeploymentView | null>>;
  deployments: ComponentFn<"query", (args: {}) => Promise<DeploymentView[]>>;
  rollback: ComponentFn<"mutation", (args: { deploymentId?: string }) => Promise<DeploymentView>>;
};

/**
 * Mounts a static site: `staticHosting({ deployToken: process.env.SITE_DEPLOY_TOKEN, httpPrefix: "/app" })`.
 * Expose only `current` to clients (for an update banner); `rollback` belongs behind your own auth check.
 */
export function staticHosting<const E extends keyof StaticHostingApi = never>(opts: StaticHostingConfig & MountOptions<E> = {}): Mount<StaticHostingApi, E> {
  const { config, options } = splitMountOptions(opts);
  const prefix = (options as { httpPrefix?: string | false }).httpPrefix;
  const withBase: StaticHostingConfig = typeof prefix === "string" ? { ...config, basePath: prefix } : config;
  return definition.mount(withBase, options) as unknown as Mount<StaticHostingApi, E>;
}

/**
 * Serves the site from an app route, for hosting at the root (component routes can't sit at "/"):
 *
 *   // onebase/http.ts
 *   http.route({ pathPrefix: "/", method: "GET", handler: httpAction((ctx, req) => serveSite(ctx.components.site, req)) });
 */
export function serveSite(
  site: { resolve: (args: { path: string }) => Promise<Resolved>; chunk: (args: { hash: string; index: number }) => Promise<string | null> },
  request: Request,
  opts: Partial<ServeOptions> = {},
): Promise<Response> {
  return serveWith(site, request, { basePath: opts.basePath ?? "", immutablePrefixes: opts.immutablePrefixes });
}
