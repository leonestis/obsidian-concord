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

// Namespace prefix for client-side IndexedDB persistence DB names
// (`<STORAGE_PREFIX>::<serverUrl>::<room>`). Purely local — does not
// affect server data, wire room names, or cross-client sync. Centralized
// here so it never drifts across the session modules.
export const STORAGE_PREFIX = "concord";

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

// Outcome of waiting for a provider's first sync. CRITICAL for the
// data-corruption fix (invariant I2): a "timeout" is NOT a sync. The
// caller must do NOTHING destructive (no seed, no adopt, no merge) on a
// timeout — the server may simply be slow and have content we haven't
// received yet. Only a genuine "synced" means the server delivered its
// state and ytext is trustworthy as "what the server has".
export type ProviderSyncOutcome = "synced" | "timeout";

// Wait until a HocuspocusProvider has completed its first TRUE sync with
// the server (the `synced` event, or it was already synced), OR until
// `timeoutMs` elapses. Returns WHICH happened so the caller can gate
// destructive seed/merge logic on a real sync (I2). Resolves "synced"
// immediately if already synced.
//
// Note: on timeout we do NOT unsubscribe — but callers that need the
// eventual real sync should use onProviderSynced instead, which is the
// event-driven path the bind/connect decision tree relies on.
export function waitForProviderSync(
  provider: HocuspocusProvider,
  timeoutMs: number,
): Promise<ProviderSyncOutcome> {
  return new Promise<ProviderSyncOutcome>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((provider as any).synced === true) {
      resolve("synced");
      return;
    }
    let done = false;
    const onSynced = () => {
      if (done) return;
      done = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).off?.("synced", onSynced);
      resolve("synced");
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).on("synced", onSynced);
    setTimeout(() => {
      if (done) return;
      done = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).off?.("synced", onSynced);
      resolve("timeout");
    }, timeoutMs);
  });
}

// Subscribe to the provider's FIRST genuine sync. Fires `cb` exactly
// once — immediately (next microtask) if the provider is already
// synced, otherwise on the first `synced` event. Returns an unsubscribe
// function. This is the event-driven path the reconcile/seed/merge
// logic uses (I2): the provider keeps trying to connect/sync in the
// background, and when the server's state truly arrives, THEN we
// reconcile — never on a mere timeout.
export function onProviderSynced(
  provider: HocuspocusProvider,
  cb: () => void,
): () => void {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).off?.("synced", onSynced);
    cb();
  };
  const onSynced = () => fire();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((provider as any).synced === true) {
    // Already synced — fire on the next microtask so the caller has
    // finished wiring up (e.g. assigned fields) before cb runs.
    queueMicrotask(fire);
    return () => {
      done = true;
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).on("synced", onSynced);
  return () => {
    if (done) return;
    done = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).off?.("synced", onSynced);
  };
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

// ── local-only conflict backups (invariant I4) ──────────────────────
//
// When a peer-originated file's local disk content differs from the
// server's ytext on first true sync and we have no merge BASE, the
// SERVER WINS: we adopt ytext and back up the local content to a
// sibling file so nothing is lost. That backup is LOCAL ONLY — it must
// never enter the manifest or sync to peers (classify() skips it).
//
// Name shape: `<path>.local-backup-<docId>.md`. The docId is a UUID, so
// names never collide (no timestamp races) and a given file/docId pair
// reuses a stable name (so repeated reconciles don't litter the vault).
const LOCAL_BACKUP_INFIX = ".local-backup-";

export function localBackupPath(path: string, docId: string): string {
  return `${path}${LOCAL_BACKUP_INFIX}${docId}.md`;
}

export function isLocalBackupPath(path: string): boolean {
  return path.includes(LOCAL_BACKUP_INFIX);
}
