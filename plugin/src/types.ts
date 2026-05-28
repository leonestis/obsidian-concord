// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared type vocabulary for obsidian-collab v1.0.0.

// "file"    = markdown (.md), per-file Y.Text with editor binding.
// "canvas"  = Obsidian Canvas (.canvas). Structural Y.Map<id, Y.Map>
//             — concurrent edits to different nodes merge cleanly.
// "text"    = atomic-replace text file (.base today, more later).
//             Single Y.Map.content string; last writer wins per save.
// "binary"  = everything else — images, PDFs, audio. Bytes are content-
//             addressed via HTTP (sha256 → /blobs/<hash>); the
//             manifest only carries the lightweight existence record.
// "folder"  = empty folder marker. No content, no Y.Doc, no blob.
export type EntryKind = "file" | "folder" | "binary" | "canvas" | "text";

// Every file-shaped manifest entry carries a stable UUID `id`. The
// Y.Doc room name for content is `doc:<id>`, NOT `file:<path>` — so
// renames preserve the same room (and its CRDT history) automatically,
// and a delete + recreate at the same path mints a fresh room with
// no chance of inheriting the old content (the "file rebirth" class
// of bugs in 0.5.x–0.9.2 vanishes by construction).
//
// For binaries, `hash` is the SHA-256 of the bytes — that's the key
// into HTTP blob storage. `size` and `mime` are denormalized cache
// hints for the UI; the bytes themselves are authoritative.
export interface ManifestEntry {
  kind: EntryKind;
  // Stable per-file UUID v4 generated at creation. Survives rename.
  // Folders also get an id for uniformity even though they have no
  // associated Y.Doc — keeps the type narrow.
  id: string;
  addedAt: number;
  // Binary-only fields. Undefined for kind != "binary".
  hash?: string;
  size?: number;
  mime?: string;
}

export interface TrashEntry {
  id: string; // same UUID this entry had in the live manifest
  path: string;
  kind: EntryKind;
  deletedAt: number;
  // Best-effort attribution. May be empty.
  deletedBy?: string;
  // For markdown / canvas / atomic-text entries: the Y.Doc room id we
  // wiped (or are about to wipe). For binaries: the content hash that
  // was deleted from disk locally — the blob on the server stays until
  // GC, so a future v1.x trash-restore could theoretically refetch it.
  // v1.0 trash is informational only — no restore UI.
  docId?: string;
  hash?: string;
}

// Kinds that map to a per-file Y.Doc room.
export type SessionKind = "file" | "canvas" | "text";

// The session-manager state machine. Every transition is atomic.
//   detached       — no session, no Y.Doc, no provider.
//   attaching      — createSession in flight; abortable.
//   bound          — session ready, optionally bound to one or more
//                    EditorViews.
//   tearing-down   — destroy in progress; concurrent attach calls await
//                    donePromise before proceeding.
export type SessionState =
  | { kind: "detached" }
  | {
      kind: "attaching";
      docId: string;
      sessionKind: SessionKind;
      abort: AbortController;
      // The in-flight attach promise. Concurrent attach() callers
      // await this directly instead of polling — fixes the
      // "session attach: gave up after retries" failure that bit us
      // in v2.0.0 when TextSession.create took longer than the
      // 100 ms polling budget (which is most of the time on real
      // networks).
      promise: Promise<AnySession | null>;
    }
  | { kind: "bound"; docId: string; sessionKind: SessionKind; session: AnySession }
  | { kind: "tearing-down"; docId: string; done: Promise<void> };

// A session-shaped object. Implementations live in text-session.ts,
// canvas-session.ts, atomic-text-session.ts.
export interface BaseSession {
  readonly sessionKind: SessionKind;
  readonly docId: string;
  // Current path. SessionManager updates this on rename.
  path: string;
  // Tear down all the Y.Doc / provider / persistence machinery.
  // Must be idempotent.
  destroy(): Promise<void>;
  // Wipe all CRDT content in this session's room. Used during delete
  // so the room genuinely vanishes from the server's working set and
  // a future room with the same docId (impossible by construction
  // since docId is a fresh UUID, but defense-in-depth) can never see
  // it again.
  wipe(): void;
}

// Marker for any session — concrete types are in their respective
// files; we keep this loose here to avoid circular imports.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySession = BaseSession & Record<string, any>;

// Protocol version stamped onto the manifest's `meta` map. 0.9.x was
// implicitly v1 (path-keyed rooms, CRDT-wrapped binaries); 1.0.0
// introduces v2 (UUID-keyed rooms, HTTP-stored binaries).
export const PROTOCOL_VERSION = 2;

export const PLUGIN_VERSION = "2.0.3";
