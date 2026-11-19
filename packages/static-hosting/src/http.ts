// The HTTP side of serving a site, kept free of onebase so the component's route and an
// app's own catch-all route (for serving at "/") share it: path rules, content types,
// cache policy, conditional requests, and streaming a file's chunks into a Response.

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  wasm: "application/wasm",
  pdf: "application/pdf",
  zip: "application/zip",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
};

/** The Content-Type for a path, from its extension (application/octet-stream when unknown). */
export function contentTypeFor(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return (ext && MIME[ext]) || "application/octet-stream";
}

/** Whether the last path segment has a file extension ("/app.js" yes, "/about" and "/v1.2/" no). */
export function hasExtension(path: string): boolean {
  return /\.[A-Za-z0-9]+$/.test(path.slice(path.lastIndexOf("/") + 1));
}

/**
 * Whether a file's name carries a content hash, as bundlers emit (`index-B71cUw87.js`,
 * `main.3f9a1c2e.css`, `chunk-LJ_VQ_AF.mjs`): such files never change under the same name,
 * so they can be cached forever. The hash part must mix in a digit, so names like
 * `privacy-policy.html` or `background.png` don't count.
 */
export function isHashedAsset(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const m = /[.-]([A-Za-z0-9_-]{8,})\.[A-Za-z0-9]+$/.exec(name);
  return !!m && /\d/.test(m[1]!) && !name.endsWith(".html");
}

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const REVALIDATE = "public, max-age=0, must-revalidate";

/** Cache-Control for a served path: hashed assets and configured prefixes are immutable, the rest revalidates. */
export function cacheControlFor(path: string, immutablePrefixes: readonly string[] = []): string {
  if (path.endsWith(".html")) return REVALIDATE;
  if (isHashedAsset(path) || immutablePrefixes.some((p) => path.startsWith(p))) return IMMUTABLE;
  return REVALIDATE;
}

/** Whether an If-None-Match header matches an ETag (weak comparison, lists and `*`). */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((t) => {
    const tag = t.trim();
    return tag === "*" || tag.replace(/^W\//, "") === bare;
  });
}

/**
 * A site path as stored: starts with "/", no empty, "." or ".." segments, no backslashes or
 * control characters. Returns null for anything else.
 */
export function normalizeSitePath(path: string): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 1024) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return null;
  const segments = path.slice(1).split("/");
  if (segments.some((s, i) => (s === "" && i !== segments.length - 1) || s === "." || s === "..")) return null;
  if (path.endsWith("/")) return null; // files only; directories resolve to their index.html
  return path;
}

/** The site path a request asks for: the URL path with the mount's base path taken off, decoded. Null when malformed. */
export function requestSitePath(pathname: string, basePath: string): string | null {
  let rest = pathname;
  if (basePath && basePath !== "/") {
    if (rest !== basePath && !rest.startsWith(basePath + "/")) return null;
    rest = rest.slice(basePath.length);
  }
  if (!rest.startsWith("/")) rest = "/" + rest;
  try {
    rest = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (/[\\\u0000-\u001f\u007f]/.test(rest)) return null;
  if (rest.split("/").some((s) => s === "." || s === "..")) return null;
  return rest;
}

/** What `resolve` answers for a request path. */
export type Resolved =
  | { kind: "empty" }
  | { kind: "notFound" }
  | {
      kind: "file";
      status: 200 | 404;
      path: string;
      hash: string;
      contentType: string;
      size: number;
      chunkCount: number;
      /** The first chunk, base64; later ones come from `chunk`. */
      data: string;
    };

/** The component functions serving needs, as plain async calls. */
export type SiteReader = {
  resolve: (args: { path: string }) => Promise<Resolved>;
  chunk: (args: { hash: string; index: number }) => Promise<string | null>;
};

export type ServeOptions = {
  /** The URL path the site lives under ("" or "/" for the root). */
  basePath: string;
  /** Path prefixes always served with an immutable Cache-Control (e.g. "/assets/"). */
  immutablePrefixes?: readonly string[];
};

const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff" };

const SETUP_PAGE = `<!doctype html><meta charset="utf-8"><title>Nothing deployed yet</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#333}code{background:#f2f2f2;padding:.1em .3em;border-radius:4px}</style>
<h1>Nothing deployed yet</h1><p>This site has no deployment. Build it and run <code>onebase-static deploy ./dist --url &lt;site url&gt;</code>.</p>`;

const fromBase64 = (data: string) => Uint8Array.from(Buffer.from(data, "base64"));

/** Answers a GET for a site file. */
export async function serveSite(reader: SiteReader, request: Request, opts: ServeOptions): Promise<Response> {
  const path = requestSitePath(new URL(request.url).pathname, opts.basePath === "/" ? "" : opts.basePath);
  if (path === null) return new Response("Bad Request", { status: 400, headers: SECURITY_HEADERS });

  const found = await reader.resolve({ path });
  if (found.kind === "empty") {
    return new Response(SETUP_PAGE, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "5", ...SECURITY_HEADERS },
    });
  }
  if (found.kind === "notFound") {
    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": REVALIDATE, ...SECURITY_HEADERS } });
  }

  const etag = `"${found.hash.slice(0, 32)}"`;
  const cacheControl = found.status === 404 ? REVALIDATE : cacheControlFor(found.path, opts.immutablePrefixes);
  const headers: Record<string, string> = { ETag: etag, "Cache-Control": cacheControl, ...SECURITY_HEADERS };
  if (found.status === 200 && etagMatches(request.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers["Content-Type"] = found.contentType;
  headers["Content-Length"] = String(found.size);

  if (found.chunkCount <= 1) return new Response(fromBase64(found.data), { status: found.status, headers });

  // Larger files stream: the first chunk came with resolve, the rest are read as the client takes them.
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const data = next === 0 ? found.data : await reader.chunk({ hash: found.hash, index: next });
        if (data === null) throw new Error(`static-hosting: chunk ${next} of ${found.hash} is missing`);
        controller.enqueue(fromBase64(data));
        if (++next >= found.chunkCount) controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
  return new Response(body, { status: found.status, headers });
}
