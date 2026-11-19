// Client for a static-hosting mount's deploy routes: walks a build directory, hashes each
// file, asks the server which contents it lacks, uploads only those, then publishes.
// Runs under bun or node 18+; `fetch` can be swapped (tests route it into a runtime).

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { contentTypeFor } from "./http";

export type DeployOptions = {
  /** The site's URL: the server origin plus the mount's httpPrefix, e.g. https://api.example.com/app */
  url: string;
  /** The mount's deployToken. */
  token: string;
  /** The build output directory (e.g. ./dist). */
  dir: string;
  label?: string;
  /** Uploads in flight at once (default 4). */
  concurrency?: number;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
};

export type DeployResult = {
  deploymentId: string;
  files: number;
  uploaded: number;
  uploadedBytes: number;
  totalBytes: number;
};

const IGNORED = new Set([".DS_Store", "Thumbs.db"]);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function call(opts: DeployOptions, method: string, path: string, body?: string | Uint8Array, contentType = "application/json"): Promise<any> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${opts.url.replace(/\/+$/, "")}/_deploy/${path}`, {
    method,
    headers: { "X-Deploy-Token": opts.token, ...(body !== undefined ? { "Content-Type": contentType } : {}) },
    body,
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${data?.error ?? text}`);
  return data;
}

/** Uploads `dir` as a new deployment and publishes it. */
export async function deploySite(opts: DeployOptions): Promise<DeployResult> {
  const log = opts.log ?? (() => {});
  const paths = await walk(opts.dir);
  if (!paths.length) throw new Error(`${opts.dir} has no files to deploy.`);

  const byHash = new Map<string, string>();
  const files = [];
  let totalBytes = 0;
  for (const full of paths) {
    const bytes = await readFile(full);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const path = "/" + relative(opts.dir, full).split(sep).join("/");
    byHash.set(hash, full);
    files.push({ path, hash, size: bytes.byteLength, contentType: contentTypeFor(path) });
    totalBytes += bytes.byteLength;
  }
  log(`${files.length} files, ${(totalBytes / 1024).toFixed(1)} KB`);

  const { deploymentId, missing } = (await call(opts, "POST", "begin", JSON.stringify({ files, label: opts.label }))) as { deploymentId: string; missing: string[] };
  log(`deployment ${deploymentId}: ${missing.length} new file content(s) to upload`);

  let uploadedBytes = 0;
  const queue = [...missing];
  const worker = async () => {
    for (let hash = queue.shift(); hash; hash = queue.shift()) {
      const bytes = await readFile(byHash.get(hash)!);
      await call(opts, "PUT", `blob/${hash}`, new Uint8Array(bytes), "application/octet-stream");
      uploadedBytes += bytes.byteLength;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));

  await call(opts, "POST", "commit", JSON.stringify({ deploymentId }));
  log(`published ${deploymentId}`);
  return { deploymentId, files: files.length, uploaded: missing.length, uploadedBytes, totalBytes };
}

/** Restores a previous deployment (the one before the live one when no id is given). */
export async function rollbackSite(opts: Pick<DeployOptions, "url" | "token" | "fetch"> & { deploymentId?: string }) {
  return call(opts as DeployOptions, "POST", "rollback", JSON.stringify(opts.deploymentId ? { deploymentId: opts.deploymentId } : {}));
}

/** The live deployment and those kept for rollback. */
export async function siteStatus(opts: Pick<DeployOptions, "url" | "token" | "fetch">) {
  return call(opts as DeployOptions, "GET", "status");
}
