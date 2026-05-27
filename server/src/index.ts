// SPDX-License-Identifier: AGPL-3.0-only
//
// obsidian-collab server, v1.0.0.
//
// Responsibilities:
//   1. Hocuspocus relay (Y.Doc rooms) — unchanged contract from 0.9.x:
//      JWT auth, MIN_CLIENT_VERSION gate, SQLite persistence with
//      fetch/store telemetry.
//   2. HTTP blob storage for binary file bytes. Bytes are content-
//      addressed by SHA-256 and live in <BLOB_DIR>/<aa>/<bbbb...> on
//      disk, one file per blob. Streamed in/out — never buffered in
//      memory — so multi-GB attachments don't OOM the process.
//
// Endpoints, mounted on Hocuspocus's own httpServer via the onRequest
// hook so blob storage and WebSocket relay share a single port:
//
//   HEAD /blobs/<hash>      200 if present, 404 otherwise.
//   PUT  /blobs/<hash>      raw body; we hash on the fly and verify
//                           it matches the URL hash. 201 on success,
//                           409 on mismatch.
//   GET  /blobs/<hash>      streams the bytes. Range support is
//                           nice-to-have and not implemented in v1.0.
//
// Auth: when JWT_SECRET is set, every blob request requires
// `Authorization: Bearer <token>` and the token must verify under the
// same secret Hocuspocus uses for the WebSocket. Empty JWT_SECRET =
// no auth, matching the WebSocket side exactly.
//
// CORS: allow * — the plugin runs inside Obsidian's WebView which
// presents a unique origin. PUT/GET/HEAD methods, Authorization +
// Content-Type headers, OPTIONS preflight answered.

import { createReadStream, createWriteStream, mkdirSync, statSync, unlinkSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@hocuspocus/server";
import { SQLite } from "@hocuspocus/extension-sqlite";
import jwt from "jsonwebtoken";

const PORT = Number(process.env.PORT ?? 1234);
const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const DB_PATH = resolve(DATA_DIR, "documents.sqlite");
const BLOB_DIR = resolve(process.env.BLOB_DIR ?? join(DATA_DIR, "blobs"));
const JWT_SECRET = process.env.JWT_SECRET ?? "";

// v1.0.0 is a clean break. 0.9.x clients used CRDT-wrapped binary
// rooms (`bin:<path>`) which no longer exist on the server, so mixing
// them with this build would just produce silent failures. Reject
// outright.
const MIN_CLIENT_VERSION = process.env.MIN_CLIENT_VERSION ?? "1.0.0";

const HASH_RE = /^[a-f0-9]{64}$/;

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(BLOB_DIR, { recursive: true });

if (!JWT_SECRET) {
  console.warn("⚠️  JWT_SECRET is not set — running in UNAUTHENTICATED mode (anyone can connect).");
} else {
  console.log("🔐 JWT authentication is REQUIRED (JWT_SECRET is set).");
}
console.log(`🧱 Minimum accepted client version: ${MIN_CLIENT_VERSION}`);
console.log(`📦 Blob directory: ${BLOB_DIR}`);
console.log(
  "🧹 Blob GC: not yet implemented (referenced-set walk + 24h grace). Slated for v1.1.",
);

function compareVersions(a: string, b: string): number {
  const parts = (s: string) =>
    s
      .replace(/^v/, "")
      .split(/[-+]/, 1)[0]
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function readClientVersion(requestParameters: unknown): string {
  if (
    requestParameters &&
    typeof (requestParameters as URLSearchParams).get === "function"
  ) {
    return (requestParameters as URLSearchParams).get("clientVersion") ?? "";
  }
  return "";
}

// ── blob storage ────────────────────────────────────────────────────────────

// Sharded path under BLOB_DIR. First two hex chars become the directory
// name so we don't end up with a single flat dir holding 100k entries
// (slow on most filesystems).
function blobPath(hash: string): string {
  return join(BLOB_DIR, hash.slice(0, 2), hash);
}

function setCors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, HEAD, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function checkAuth(req: IncomingMessage): { ok: boolean; reason?: string } {
  if (!JWT_SECRET) return { ok: true };
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return { ok: false, reason: "missing Bearer token" };
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) return { ok: false, reason: "empty token" };
  try {
    jwt.verify(token, JWT_SECRET);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

function send(res: ServerResponse, status: number, body?: string) {
  setCors(res);
  res.statusCode = status;
  if (body != null) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(body);
  } else {
    res.end();
  }
}

async function handleBlobHead(res: ServerResponse, hash: string) {
  try {
    const st = await stat(blobPath(hash));
    setCors(res);
    res.statusCode = 200;
    res.setHeader("Content-Length", String(st.size));
    res.end();
  } catch {
    send(res, 404);
  }
}

async function handleBlobGet(res: ServerResponse, hash: string) {
  const path = blobPath(hash);
  let st;
  try {
    st = await stat(path);
  } catch {
    send(res, 404);
    return;
  }
  setCors(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(st.size));
  // Stream — never buffer.
  try {
    await pipeline(createReadStream(path), res);
  } catch (err) {
    console.warn(`💥 GET /blobs/${hash} pipeline failed`, err);
    // Headers/body already partly sent; can't reliably set status now.
  }
}

async function handleBlobPut(
  req: IncomingMessage,
  res: ServerResponse,
  hash: string,
) {
  const dir = join(BLOB_DIR, hash.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  // Write to a temp file first, then rename to the final name only if
  // the hash matches. Avoids a corrupted blob ever appearing at the
  // canonical path.
  const tmp = blobPath(hash) + ".tmp." + process.pid + "." + Date.now();
  const hasher = createHash("sha256");
  const out = createWriteStream(tmp);
  let bytes = 0;
  req.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    hasher.update(chunk);
  });
  try {
    await pipeline(req, out);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    console.warn(`💥 PUT /blobs/${hash} stream failed`, err);
    send(res, 500, "stream failed");
    return;
  }
  const computed = hasher.digest("hex");
  if (computed !== hash) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    console.warn(
      `✋ PUT /blobs/${hash} hash mismatch (computed ${computed}, ${bytes}b)`,
    );
    send(res, 409, `hash mismatch: computed ${computed}`);
    return;
  }
  // Atomic rename into place.
  try {
    const fs = await import("node:fs/promises");
    await fs.rename(tmp, blobPath(hash));
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    console.warn(`💥 PUT /blobs/${hash} rename failed`, err);
    send(res, 500, "rename failed");
    return;
  }
  console.log(`📥 PUT /blobs/${hash} stored (${bytes} bytes)`);
  send(res, 201, "ok");
}

async function handleBlobRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "";
  // Preflight: handle for any /blobs/* path.
  if (req.method === "OPTIONS" && url.startsWith("/blobs/")) {
    setCors(res);
    res.statusCode = 204;
    res.end();
    return true;
  }
  const m = /^\/blobs\/([^/?#]+)(?:[?#].*)?$/.exec(url);
  if (!m) return false;
  const hash = m[1].toLowerCase();
  if (!HASH_RE.test(hash)) {
    send(res, 400, "invalid hash");
    return true;
  }
  const auth = checkAuth(req);
  if (!auth.ok) {
    send(res, 401, `unauthorized: ${auth.reason}`);
    return true;
  }
  try {
    if (req.method === "HEAD") {
      await handleBlobHead(res, hash);
      return true;
    }
    if (req.method === "GET") {
      await handleBlobGet(res, hash);
      return true;
    }
    if (req.method === "PUT") {
      await handleBlobPut(req, res, hash);
      return true;
    }
    send(res, 405, "method not allowed");
    return true;
  } catch (err) {
    console.warn(`💥 blob handler failed`, err);
    if (!res.headersSent) send(res, 500, "internal error");
    return true;
  }
}

// ── Hocuspocus relay ────────────────────────────────────────────────────────

const sqlite = new SQLite({ database: DB_PATH });
const origConfig = (sqlite as any).configuration;
const wrappedFetch = origConfig.fetch;
const wrappedStore = origConfig.store;
(sqlite as any).configuration = {
  ...origConfig,
  fetch: async (data: { documentName: string }) => {
    try {
      const result = await wrappedFetch(data);
      console.log(`💾 FETCH "${data.documentName}" → ${result ? `${result.length} bytes` : "nothing"}`);
      return result;
    } catch (err) {
      console.error(`💥 FETCH failed for "${data.documentName}":`, err);
      throw err;
    }
  },
  store: async (data: { documentName: string; state: Buffer }) => {
    const before = (() => { try { return statSync(DB_PATH).size; } catch { return -1; } })();
    try {
      await wrappedStore(data);
      const after = (() => { try { return statSync(DB_PATH).size; } catch { return -1; } })();
      console.log(`💾 STORE "${data.documentName}" ${data.state.length} bytes → sqlite ${before}→${after} bytes`);
    } catch (err) {
      console.error(`💥 STORE failed for "${data.documentName}":`, err);
      throw err;
    }
  },
};

const server = new Server({
  port: PORT,
  extensions: [sqlite],

  async onConnect({ documentName, requestParameters }) {
    const clientVersion = readClientVersion(requestParameters);
    if (
      !clientVersion ||
      compareVersions(clientVersion, MIN_CLIENT_VERSION) < 0
    ) {
      console.warn(
        `✋ rejecting connection: clientVersion="${clientVersion || "(none)"}" < ${MIN_CLIENT_VERSION} (room "${documentName}")`,
      );
      throw new Error(
        `obsidian-collab: client version ${clientVersion || "unknown"} is too old. ` +
          `Update the plugin to ${MIN_CLIENT_VERSION} or newer.`,
      );
    }
    console.log(
      `→ client v${clientVersion} connected to room "${documentName}"`,
    );
  },

  async onChange({ documentName, clientsCount, update }) {
    console.log(`📝 CHANGE in "${documentName}" (update=${update.length}b, clients=${clientsCount})`);
  },

  async onStoreDocument({ documentName, clientsCount }) {
    console.log(`📌 onStoreDocument hook fired: "${documentName}" (clients=${clientsCount})`);
  },

  async onAuthenticate({ token }) {
    if (!JWT_SECRET) return {};
    if (!token) throw new Error("auth required: no token");
    try {
      const payload = jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
      return { user: payload };
    } catch (err) {
      throw new Error(`auth failed: ${(err as Error).message}`);
    }
  },

  async onDisconnect({ documentName }) {
    console.log(`← client disconnected from room "${documentName}"`);
  },

  // NOTE: We intentionally do NOT use the `onRequest` hook for blob
  // routes. Hocuspocus's onRequest contract documents "throw to stop
  // handling", but its requestHandler (Server.ts:116) catches the
  // throw with `if (error) throw error` which then rethrows out of
  // the async http listener — Node 22's default unhandled-rejection
  // behaviour kills the process. We end up in a crash-restart loop
  // every time a blob request arrives. Instead we patch the http
  // request listener directly below, after Server construction but
  // before listen(). That way our blob handler runs first, can fully
  // respond and return without involving Hocuspocus at all.
});

// Replace Hocuspocus's request listener with a wrapper that handles
// blob routes first. If our handler responds to the request, the
// original Hocuspocus handler never runs (no double-response, no
// "Welcome to Hocuspocus!" fallback after a real response). If the
// request isn't a blob route, we delegate to the original handler
// unchanged so the standard Hocuspocus HTTP behaviour still works.
{
  const origListeners = server.httpServer.listeners("request") as Array<
    (req: any, res: any) => void
  >;
  if (origListeners.length !== 1) {
    console.warn(
      `expected exactly 1 request listener on Hocuspocus httpServer, found ${origListeners.length}. ` +
        `Wrapping anyway, but Hocuspocus internals may have changed.`,
    );
  }
  const origHandler = origListeners[0];
  server.httpServer.removeAllListeners("request");
  server.httpServer.on("request", async (req, res) => {
    try {
      if (await handleBlobRequest(req, res)) return;
    } catch (err) {
      console.error("[blob] handler crashed", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      if (!res.writableEnded) res.end("internal error");
      return;
    }
    // Not a blob route — let Hocuspocus's default handler run.
    origHandler(req, res);
  });
}

await server.listen();
console.log(`obsidian-collab server v1.0.0 listening on ws://localhost:${PORT}`);
console.log(`blob endpoints: http://localhost:${PORT}/blobs/<hash>`);
console.log(`persistence: ${DB_PATH}`);
