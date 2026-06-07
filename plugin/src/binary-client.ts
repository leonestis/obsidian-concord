// SPDX-License-Identifier: AGPL-3.0-only
//
// HTTP client for the v1.0 blob endpoints (HEAD/PUT/GET /blobs/<hash>).
// Replaces the CRDT-wrapped binary rooms used in 0.9.x — bytes never
// go through Yjs anymore, so the manifest stays tiny and arbitrarily
// large files (multi-GB PDFs etc) don't blow up server memory.
//
// The plugin runs inside Obsidian's WebView, which is essentially a
// Chromium origin with `fetch` available. We use `fetch` directly
// rather than Obsidian's `requestUrl` because we need:
//   1. streaming upload bodies (Uint8Array is fine, but request-url
//      buffers and re-serializes),
//   2. HEAD method support (some older Obsidian builds rewrote HEAD
//      to GET via requestUrl).

import { sha256Hex } from "./util";

export interface BlobProgress {
  loaded: number;
  total: number;
}

// Error subclass so callers can distinguish "the server rejected our
// credentials" from "the server is down" from "the blob isn't there"
// — handy for surfacing a one-time Notice to the user on auth failure
// instead of silently retrying forever on every binary in a vault.
export class BlobAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobAuthError";
  }
}

// 404 — the blob isn't on the server yet. This is the common race: a
// peer's manifest entry (tiny Yjs update) arrives before their PUT of
// the bytes finishes. RETRYABLE: the bytes are very likely on their
// way. Distinguished from a generic Error so the download-retry logic
// in manifest-sync can back off and re-attempt rather than stranding
// the file.
export class BlobNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobNotFoundError";
  }
}

// The downloaded bytes don't hash to the value the manifest promised.
// POISON: retrying the same content-addressed URL can only ever return
// the same wrong bytes, so the caller must NOT loop — log and give up.
// Either the server is serving a corrupted/wrong object for this hash
// or the manifest entry is bad; either way more GETs won't fix it.
export class BlobHashMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `blob hash mismatch: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
    );
    this.name = "BlobHashMismatchError";
  }
}

export class BinaryClient {
  // Suppress repeated auth-failure Notices — one toast per client
  // instance is enough; users get tired fast when every binary in a
  // vault fires its own. Reset on construction (settings save → fresh
  // client).
  private authErrorNoticed = false;

  constructor(
    // e.g. "http://your-server.example.com:1234". No trailing slash.
    private readonly baseUrl: string,
    private readonly authToken: string | undefined,
    // Optional Notice surface. Undefined in tests / when we don't have
    // an Obsidian app handy. The string is shown verbatim.
    private readonly onAuthError?: (msg: string) => void,
  ) {}

  private signalAuthError(detail: string): void {
    if (this.authErrorNoticed) return;
    this.authErrorNoticed = true;
    try {
      this.onAuthError?.(detail);
    } catch {
      /* never let a notice handler take down a blob op */
    }
  }

  private url(hash: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/blobs/${hash}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...(extra ?? {}) };
    if (this.authToken) h["Authorization"] = `Bearer ${this.authToken}`;
    return h;
  }

  // Existence check — used by upload to skip a re-PUT when the server
  // already has the bytes. Returns true on HTTP 200, false on 404,
  // throws on any other status so the caller can surface auth /
  // network problems.
  async exists(hash: string): Promise<boolean> {
    const res = await fetch(this.url(hash), {
      method: "HEAD",
      headers: this.headers(),
    });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    if (res.status === 401 || res.status === 403) {
      this.signalAuthError(
        `Concord blob server rejected the auth token (${res.status}). Binary file sync is paused — open settings and refresh your Auth token, then reconnect.`,
      );
      throw new BlobAuthError(`HEAD /blobs/${hash} → ${res.status}`);
    }
    throw new Error(`HEAD /blobs/${hash} unexpected ${res.status}`);
  }

  // Upload bytes. Caller has already computed the hash; the server
  // verifies it. We pass the Uint8Array body as-is; fetch handles
  // length headers and (on chromium) streaming.
  //
  // Progress reporting is best-effort — fetch's request-progress API
  // is a ReadableStream that not every WebView build supports. When
  // unavailable, we just fire 0% and 100%.
  async upload(
    bytes: Uint8Array,
    hash: string,
    onProgress?: (frac: number) => void,
  ): Promise<void> {
    onProgress?.(0);
    const res = await fetch(this.url(hash), {
      method: "PUT",
      headers: this.headers({ "Content-Type": "application/octet-stream" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: bytes as any,
    });
    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => "");
      this.signalAuthError(
        `Concord blob server rejected the auth token (${res.status}). Binary file sync is paused — open settings and refresh your Auth token, then reconnect.`,
      );
      throw new BlobAuthError(`PUT /blobs/${hash} → ${res.status}: ${text}`);
    }
    if (res.status !== 201 && res.status !== 200) {
      const text = await res.text().catch(() => "");
      throw new Error(`PUT /blobs/${hash} → ${res.status}: ${text}`);
    }
    onProgress?.(1);
  }

  // Download bytes. Uses the streaming Response.body when available
  // so we can fire progress callbacks; otherwise falls back to
  // arrayBuffer() in one shot.
  //
  // Error contract (so callers can decide whether to retry):
  //   404               → BlobNotFoundError   (retryable: PUT in flight)
  //   401 / 403         → BlobAuthError       (not retryable here)
  //   other !ok / fetch → Error               (retryable: transient net/5xx)
  //   hash mismatch     → BlobHashMismatchError (POISON: never retry)
  //
  // FIX D — content integrity: the download is content-addressed, so
  // the `hash` argument IS the expected SHA-256 of the bytes. We verify
  // sha256(bytes) === hash before returning. A corrupted or wrong blob
  // is rejected rather than written to the vault as the "correct" file,
  // completing the integrity guarantee the upload path already enforces
  // server-side. Pass verify=false only when bytes will be re-hashed by
  // the caller anyway (currently nobody does).
  async download(
    hash: string,
    onProgress?: (frac: number) => void,
    verify: boolean = true,
  ): Promise<Uint8Array> {
    const res = await fetch(this.url(hash), {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status === 404) throw new BlobNotFoundError(`blob ${hash} not found`);
    if (res.status === 401 || res.status === 403) {
      this.signalAuthError(
        `Concord blob server rejected the auth token (${res.status}). Binary file sync is paused — open settings and refresh your Auth token, then reconnect.`,
      );
      throw new BlobAuthError(`GET /blobs/${hash} → ${res.status}`);
    }
    if (!res.ok) throw new Error(`GET /blobs/${hash} → ${res.status}`);
    const total = Number(res.headers.get("Content-Length") ?? "0");
    onProgress?.(0);
    let out: Uint8Array;
    if (!res.body || typeof res.body.getReader !== "function") {
      out = new Uint8Array(await res.arrayBuffer());
    } else {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          loaded += value.byteLength;
          if (total > 0) onProgress?.(loaded / total);
        }
      }
      out = new Uint8Array(loaded);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
    }
    onProgress?.(1);
    if (verify) {
      const actual = await sha256Hex(out);
      if (actual !== hash) throw new BlobHashMismatchError(hash, actual);
    }
    return out;
  }
}
