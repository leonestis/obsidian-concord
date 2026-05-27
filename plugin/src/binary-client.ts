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
        `Collab blob server rejected the auth token (${res.status}). Binary file sync is paused — open settings and refresh your Auth token, then reconnect.`,
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
        `Collab blob server rejected the auth token (${res.status}). Binary file sync is paused — open settings and refresh your Auth token, then reconnect.`,
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
  async download(
    hash: string,
    onProgress?: (frac: number) => void,
  ): Promise<Uint8Array> {
    const res = await fetch(this.url(hash), {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status === 404) throw new Error(`blob ${hash} not found`);
    if (res.status === 401 || res.status === 403) {
      this.signalAuthError(
        `Collab blob server rejected the auth token (${res.status}). Binary file sync is paused — open settings and refresh your Auth token, then reconnect.`,
      );
      throw new BlobAuthError(`GET /blobs/${hash} → ${res.status}`);
    }
    if (!res.ok) throw new Error(`GET /blobs/${hash} → ${res.status}`);
    const total = Number(res.headers.get("Content-Length") ?? "0");
    onProgress?.(0);
    if (!res.body || typeof res.body.getReader !== "function") {
      const buf = new Uint8Array(await res.arrayBuffer());
      onProgress?.(1);
      return buf;
    }
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
    const out = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    onProgress?.(1);
    return out;
  }
}
