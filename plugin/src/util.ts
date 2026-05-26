// SPDX-License-Identifier: AGPL-3.0-only
//
// Small helpers shared across modules.

import { HocuspocusProvider } from "@hocuspocus/provider";

// Y.Doc room name for any per-file content session. UUID-keyed so the
// same room follows a file through every rename and a delete+recreate
// at the same path produces a fresh room (no rebirth possible).
//
// Slashes in UUIDs are impossible (they're hex + dashes), so we don't
// need any escaping — just a stable prefix.
export function docIdToRoom(docId: string): string {
  return "doc:" + docId;
}

export const MANIFEST_ROOM = "vault:manifest";

// Pleasant palette for auto-assigning a color when the user hasn't picked one.
const PALETTE = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#3b82f6", "#6366f1", "#a855f7", "#ec4899",
];

export function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function randomName(): string {
  return `user-${Math.floor(Math.random() * 9000 + 1000)}`;
}

// UUID v4. Uses crypto.randomUUID when available (everywhere modern),
// falls back to a Math.random-based id only in pathological
// environments — manifests prefer correctness here so we log a warning
// if we ever take the fallback.
export function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  console.warn("[collab] crypto.randomUUID unavailable — using insecure fallback");
  const r = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
  return `${r()}${r()}-${r()}-4${r().slice(1)}-${r()}-${r()}${r()}${r()}`;
}

// SHA-256 hex string of a byte buffer. Used both for the
// content-addressed blob URL and for skip-if-unchanged checks on
// re-upload.
export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  // Always materialise into a fresh ArrayBuffer copy. Uint8Array
  // values that came out of Yjs can be backed by SharedArrayBuffer on
  // some runtimes, and SubtleCrypto's TS type rejects that. The copy
  // is cheap and avoids the type gymnastics.
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ab = new ArrayBuffer(src.byteLength);
  new Uint8Array(ab).set(src);
  const hash = await crypto.subtle.digest("SHA-256", ab);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Wait until a HocuspocusProvider has completed its first sync with
// the server (or until `timeoutMs` elapses). Resolves immediately if
// already synced.
export function waitForProviderSync(
  provider: HocuspocusProvider,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((provider as any).synced === true) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).off?.("synced", finish);
      resolve();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).on("synced", finish);
    setTimeout(finish, timeoutMs);
  });
}

// Strip ws:// or wss:// and replace with http:// or https://. Used to
// derive the default blob server URL from the Hocuspocus WebSocket URL
// — they live on the same port unless explicitly overridden.
export function deriveBlobUrl(serverUrl: string): string {
  if (serverUrl.startsWith("wss://")) return "https://" + serverUrl.slice(6);
  if (serverUrl.startsWith("ws://")) return "http://" + serverUrl.slice(5);
  if (serverUrl.startsWith("https://") || serverUrl.startsWith("http://")) return serverUrl;
  // Unknown scheme — default to http and hope.
  return "http://" + serverUrl.replace(/^[a-z]+:\/\//, "");
}

// Tiny extension → MIME map. The system MIME registry isn't available
// in the browser; this covers everything the user is likely to drop
// into a vault. Default falls back to application/octet-stream.
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
  pdf: "application/pdf",
  zip: "application/zip",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

export function mimeFromExtension(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? "application/octet-stream";
}

// Vault path → containing folder. Empty string if at the root.
export function parentFolder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "" : path.substring(0, slash);
}
