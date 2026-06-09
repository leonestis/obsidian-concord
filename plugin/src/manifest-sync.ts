// SPDX-License-Identifier: AGPL-3.0-only
//
// Vault manifest sync. One shared Y.Doc holds three maps:
//   files  — path → ManifestEntry { kind, id, addedAt, hash?, size?, mime? }
//   trash  — id   → TrashEntry { path, kind, deletedAt, docId?, hash? }
//   meta   — { protocolVersion: 2, ... }
//
// The map key is still `path` (it's the natural unit Obsidian reports
// in vault events), but every entry carries a stable UUID `id` that
// keys the per-file Y.Doc room (`doc:<id>`). That means:
//   - rename = delete(oldPath) + set(newPath, sameEntry) in one
//     transaction. Same docId, same room, content persists.
//   - delete = delete(path) + trash.set(id, ...). The session manager
//     wipes the room before tearing it down so the next file with the
//     same path (which gets a brand new id) can never inherit content.
//   - binary = the entry carries `hash`; bytes live in HTTP blob storage,
//     never in Yjs.
//
// Reconcile on connect: walk the manifest, for each entry not present
// locally → materialise (download via blob client if binary; open
// session if canvas/atomic; create empty file if markdown). Then walk
// the local vault, for each file not in the manifest → mint a fresh
// UUID and register it.

import {
  App,
  Notice,
  TAbstractFile,
  TFile,
  TFolder,
} from "obsidian";
import { HocuspocusProvider, type HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

import { log } from "./logger";
import { DiskBuffer } from "./disk-buffer";
import { MANIFEST_ROOM, STORAGE_PREFIX, isLocalBackupPath, mimeFromExtension, sha256Hex, uuid } from "./util";
import {
  PROTOCOL_VERSION,
  type EntryKind,
  type ManifestEntry,
  type RosterEntry,
  type SessionKind,
  type TrashEntry,
} from "./types";
import type { SessionManager } from "./session-manager";
import type { BinaryClient } from "./binary-client";
import { BlobHashMismatchError } from "./binary-client";
import { purgeOldTrash } from "./trash";

const CANVAS_EXTENSIONS = new Set(["canvas"]);
const ATOMIC_TEXT_EXTENSIONS = new Set(["base"]);
const SUPPRESS_HOLD_MS = 1000;

// Plugin warns at this size — doesn't block.
export const LARGE_FILE_WARN_BYTES = 50 * 1024 * 1024;

// Cap parallel binary downloads during reconcile so a vault with 50
// PDFs doesn't serialize and doesn't open 50 fetches at once.
const MAX_PARALLEL_DOWNLOADS = 4;

// FIX B — bounded retry for binary downloads. A peer's manifest entry
// (tiny Yjs update) routinely arrives before their blob PUT finishes,
// so the first GET 404s; a transient network blip / 5xx does the same.
// Both are retryable. We back off geometrically and cap the wait so a
// genuinely-missing blob doesn't hammer the server.
//
// Delays between attempts: 1s, 2s, 4s, 8s (capped). With 5 attempts
// that's ~15s of patience inside a single materialise call before the
// path is parked in `pendingDownloads` for the slow-path retry loop.
const DOWNLOAD_RETRY_ATTEMPTS = 5;
const DOWNLOAD_RETRY_BASE_MS = 1000;
const DOWNLOAD_RETRY_MAX_MS = 8000;

// Slow-path sweep: while any binaries are still stranded (all in-call
// retries exhausted), re-attempt them on this cadence so a blob that
// lands late eventually materialises without a manual reconnect. The
// sweep also runs on every `synced` (reconnect) event.
const PENDING_SWEEP_MS = 30_000;

// ── Mass-delete circuit breaker ──────────────────────────────────────
// Local deletes are buffered for this window so a burst (e.g. a folder
// moved in the OS file manager, which makes Obsidian report every file
// inside it as deleted) can be characterized as a single batch instead
// of propagating file-by-file.
const DELETE_HOLD_MS = 1200;
// If one buffered batch deletes more than this many files, DON'T
// propagate — ask the user first (default = keep). This is the guard
// against a moved/renamed vault folder nuking everyone's data.
const MASS_DELETE_THRESHOLD = 10;

export interface ManifestSyncDeps {
  app: App;
  serverUrl: () => string;
  authToken: () => string | undefined;
  getSocket: () => HocuspocusProviderWebsocket | null;
  sessionManager: SessionManager;
  binaryClient: () => BinaryClient | null;
  remoteApplyPaths: {
    add: (p: string) => void;
    delete: (p: string) => void;
    has: (p: string) => boolean;
  };
  onDownloadProgress: (label: string | null) => void;
  // FIX A — fired when the manifest provider's WebSocket handshake is
  // rejected by the server for auth reasons. main.ts owns the socket
  // lifecycle, so it (not ManifestSync) decides to disconnect() the
  // shared websocket, flip the persistent "auth failed" state, and
  // surface the status-bar indicator. The manifest provider is the
  // canonical auth signal because it's the always-on room that's open
  // the moment the socket connects.
  onAuthFailed: (reason: string) => void;
  // v2.1.x: "is a CM editor currently open on this markdown path?".
  // Wired to LiveViewManager.hasEditorFor. Background disk→Y capture in
  // onLocalModify uses it to DEFER to the editor binding for open files
  // (the editor owns disk↔Y for them) and only run the diff path for
  // files with no live editor. Optional so call sites that build deps
  // before LiveViewManager exists don't break. When ABSENT we treat the
  // file as "editor present" and DEFER (skip background capture) — the
  // safe branch, since fighting an open editor's disk↔Y binding is the
  // worse failure. In practice main.ts wires it before any modify fires.
  hasEditorFor?: (path: string) => boolean;
  // Data-safety guard. Fired when an unusually large batch of LOCAL file
  // deletions arrives at once (the classic "moved the vault folder in
  // Finder → Obsidian reports every file deleted" accident). The plugin
  // has already BUFFERED the batch and will NOT propagate it on its own;
  // this asks the UI what to do. `confirmDelete` propagates the deletions
  // to all peers; `keep` discards them and restores the local copies from
  // the server. If this dep is absent, the plugin defaults to `keep`.
  onMassDelete?: (
    paths: string[],
    confirmDelete: () => void,
    keep: () => void,
  ) => void;
  debug: (...args: unknown[]) => void;
}

export class ManifestSync {
  private ydoc: Y.Doc | null = null;
  private map: Y.Map<ManifestEntry> | null = null;
  private trash: Y.Map<TrashEntry> | null = null;
  private meta: Y.Map<unknown> | null = null;
  // Presence roster — a NEW Y.Map, independent of files/trash/meta.
  // Read/written ONLY by the Collaborators panel via the accessors
  // below. Adding it does not touch any content-sync observer or path.
  private roster: Y.Map<RosterEntry> | null = null;
  private provider: HocuspocusProvider | null = null;
  private persistence: IndexeddbPersistence | null = null;
  private mapObserver:
    | ((event: Y.YMapEvent<ManifestEntry>) => void)
    | null = null;
  // Guard against re-entrant reconcile. The provider can emit `synced`
  // more than once (initial sync, reconnect, etc), and the manifest
  // observer can also kick during a reconcile. Serialise via this
  // promise so the second caller waits for the first to finish before
  // computing a fresh localPaths snapshot.
  private reconcileInFlight: Promise<void> | null = null;

  // FIX B — paths whose blob download failed every in-call retry (blob
  // not on the server yet, or a stubborn transient error). Keyed by
  // path → the manifest entry to re-materialise. The slow-path sweep
  // (interval + every `synced`) drains this so a stranded image
  // resolves once the uploader's PUT finally lands, with no manual
  // reconnect. Hash-mismatch (poison) entries are NEVER parked here —
  // re-downloading the same content hash can't fix corrupted bytes.
  private pendingDownloads = new Map<string, ManifestEntry>();
  private pendingSweepTimer: ReturnType<typeof setInterval> | null = null;
  // Single-flight guard so overlapping triggers (interval fires while a
  // `synced`-driven sweep is still running) don't double-download.
  private pendingSweepInFlight = false;

  // Mass-delete circuit breaker state. Local deletes accumulate here and
  // are decided as a batch when the hold timer fires (see onLocalDelete /
  // flushDeletes).
  // path → { the file, the manifest id at buffer time }. The id lets us
  // skip a delete if the path was re-created with a NEW identity between
  // buffering and flushing (delete + recreate at the same path).
  private deleteBuffer = new Map<string, { file: TAbstractFile; id: string }>();
  private deleteFlushTimer: ReturnType<typeof setTimeout> | null = null;

  // v2.0.0 event emitter: fires `sessionReady(path)` whenever a session
  // transitions into the bound state. LiveViewManager subscribes via
  // onSessionReady() and queues a refresh — that's how the editor
  // binding lifecycle catches up when a session finishes attaching
  // AFTER the file's leaf is already open.
  //
  // ManifestSync is the natural place to host the emitter because it
  // already orchestrates session attach calls and there's a single
  // SessionManager → ManifestSync → main.ts → LiveViewManager wire we
  // can route the event through. The emitter wraps SessionManager's
  // setSessionReadyEmitter — we register a forwarder on construction
  // (see main.ts), and SessionManager fires it on every successful
  // attach.
  private sessionReadyListeners: Array<(path: string) => void> = [];

  constructor(private readonly deps: ManifestSyncDeps) {}

  // Subscribe to "this session is now bound" events. Returns an
  // unsubscribe function. Used by LiveViewManager.
  onSessionReady(cb: (path: string) => void): () => void {
    this.sessionReadyListeners.push(cb);
    return () => {
      const i = this.sessionReadyListeners.indexOf(cb);
      if (i >= 0) this.sessionReadyListeners.splice(i, 1);
    };
  }

  // Called from main.ts's wire-up — passed to SessionManager so it can
  // fire sessionReady from inside attach() when the bound state is
  // reached. We don't filter by kind here; the listeners themselves
  // decide what to do (LiveViewManager only cares about markdown).
  emitSessionReady(path: string): void {
    for (const cb of this.sessionReadyListeners) {
      try {
        cb(path);
      } catch (err) {
        log.warn("sync", "sessionReady listener threw", err);
      }
    }
  }

  isReady(): boolean {
    return this.map !== null;
  }
  getTrash(): Y.Map<TrashEntry> | null {
    return this.trash;
  }

  // ── presence (Collaborators panel) ──────────────────────────────────
  //
  // Clean accessors so the panel never reaches into our privates. All
  // three return null before start()/after stop(). The panel publishes
  // local presence into the awareness and reads peers from it + the
  // roster; it must never touch the files/trash/meta content maps.

  // The manifest provider's awareness — the always-on GLOBAL presence
  // channel. The panel writes the local presence field here and listens
  // for `change` to learn who's online. This is a SEPARATE channel from
  // the doc; writing the local awareness state cannot affect content.
  getPresenceAwareness(): Awareness | null {
    return this.provider?.awareness ?? null;
  }

  // The roster Y.Map (offline last-seen tracking). Separate from
  // files/trash/meta — safe to read/observe/upsert without touching
  // content sync.
  getRoster(): Y.Map<RosterEntry> | null {
    return this.roster;
  }

  // The shared Y.Doc, exposed ONLY so the panel can wrap a roster upsert
  // in a transaction (this.ydoc.transact). Callers MUST write to the
  // roster map only — never files/trash/meta.
  getDoc(): Y.Doc | null {
    return this.ydoc;
  }

  // Upsert the local user's roster entry in one transaction. Called by
  // the panel on connect and whenever activeFile changes. Touches ONLY
  // the roster map. lastSeen uses Date.now() (presence, not the
  // deterministic-content path, so wall-clock is fine).
  upsertRoster(presenceId: string, name: string, color: string): void {
    if (!this.roster || !this.ydoc) return;
    this.ydoc.transact(() => {
      this.roster!.set(presenceId, { name, color, lastSeen: Date.now() });
    });
  }

  // Purge roster entries older than `maxAgeMs` (default 30 days) so the
  // roster can't grow unbounded as people come and go. Touches ONLY the
  // roster map. Called once after the manifest first syncs.
  purgeOldRoster(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): void {
    if (!this.roster || !this.ydoc) return;
    const cutoff = Date.now() - maxAgeMs;
    const stale: string[] = [];
    for (const [id, entry] of this.roster.entries()) {
      if (typeof entry.lastSeen !== "number" || entry.lastSeen < cutoff) {
        stale.push(id);
      }
    }
    if (stale.length === 0) return;
    this.ydoc.transact(() => {
      for (const id of stale) this.roster!.delete(id);
    });
    log.info("presence", `purged ${stale.length} stale roster entries`);
  }
  // Lookup helper for main.ts's file-open handler: returns the manifest
  // entry for a path, or null if the manifest isn't loaded yet or has
  // no entry. Used to drive auto-attach on file-open for markdown files
  // that were created by a peer (so their session was never opened
  // locally by `onLocalCreate`).
  getEntry(path: string): ManifestEntry | null {
    return this.map?.get(path) ?? null;
  }

  start(): void {
    const socket = this.deps.getSocket();
    if (!socket || this.provider) return;

    this.ydoc = new Y.Doc();
    this.map = this.ydoc.getMap<ManifestEntry>("files");
    this.trash = this.ydoc.getMap<TrashEntry>("trash");
    this.meta = this.ydoc.getMap<unknown>("meta");
    // Presence roster — separate Y.Map, never read by content sync.
    this.roster = this.ydoc.getMap<RosterEntry>("roster");

    this.provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: MANIFEST_ROOM,
      document: this.ydoc,
      token: this.deps.authToken() || undefined,
    });
    this.provider.attach();

    this.persistence = new IndexeddbPersistence(
      `${STORAGE_PREFIX}::${this.deps.serverUrl()}::${MANIFEST_ROOM}`,
      this.ydoc,
    );

    this.provider.on("synced", () => {
      log.info("sync", `manifest synced (${this.map?.size ?? 0} entries)`);
      // Protocol gate
      const serverProtocol =
        (this.meta?.get("protocolVersion") as number | undefined) ?? 0;
      if (serverProtocol > PROTOCOL_VERSION) {
        log.warn(
          "sync",
          `server protocol v${serverProtocol} > ours v${PROTOCOL_VERSION} — entering read-only`,
        );
        this.deps.sessionManager.setReadOnly(true);
        return;
      }
      this.deps.sessionManager.setReadOnly(false);
      if (serverProtocol < PROTOCOL_VERSION) {
        this.meta?.set("protocolVersion", PROTOCOL_VERSION);
        log.info("sync", `stamped manifest protocolVersion=${PROTOCOL_VERSION}`);
      }
      void this.runReconcile();
      // Presence roster housekeeping (Collaborators panel) — bound its
      // growth on every sync. Roster map only; never touches content.
      this.purgeOldRoster();
      // FIX B — a (re)sync is the best moment to retry stranded blobs:
      // the peer's PUT very likely completed while we were disconnected.
      void this.sweepPendingDownloads("synced");
    });

    this.provider.on(
      "authenticationFailed",
      (d: { reason: string }) => {
        log.error("sync", `manifest auth failed: ${d.reason}`);
        // FIX A — hand off to main.ts, which disconnects the shared
        // websocket (stopping the reconnect storm), sets the persistent
        // authFailed state and updates the status bar. We deliberately
        // do NOT new Notice() here anymore: the one-shot toast was the
        // old behaviour that let the storm run silently. main.ts now
        // owns the persistent indicator + recovery path.
        this.deps.onAuthFailed(d.reason);
      },
    );

    this.mapObserver = (event) => void this.onManifestChange(event);
    this.map.observe(this.mapObserver);

    // FIX B — slow-path retry loop for stranded binaries. Runs only
    // while `pendingDownloads` is non-empty (the sweep is a cheap no-op
    // otherwise), so an idle vault pays nothing.
    if (!this.pendingSweepTimer) {
      this.pendingSweepTimer = setInterval(() => {
        if (this.pendingDownloads.size === 0) return;
        void this.sweepPendingDownloads("timer");
      }, PENDING_SWEEP_MS);
    }
  }

  async stop(): Promise<void> {
    if (this.pendingSweepTimer) {
      clearInterval(this.pendingSweepTimer);
      this.pendingSweepTimer = null;
    }
    // Drop any buffered (un-decided) deletes — they reference a doc we're
    // about to tear down, and a fresh start() re-derives state.
    if (this.deleteFlushTimer) {
      clearTimeout(this.deleteFlushTimer);
      this.deleteFlushTimer = null;
    }
    this.deleteBuffer.clear();
    // Drop parked retries — a fresh start()/reconcile re-derives what's
    // missing, and the entries reference a doc we're about to destroy.
    this.pendingDownloads.clear();
    this.pendingSweepInFlight = false;
    if (this.map && this.mapObserver) {
      try {
        this.map.unobserve(this.mapObserver);
      } catch {
        /* ignore */
      }
    }
    this.mapObserver = null;
    this.provider?.destroy();
    this.provider = null;
    try {
      await this.persistence?.destroy();
    } catch {
      /* ignore */
    }
    this.persistence = null;
    this.ydoc?.destroy();
    this.ydoc = null;
    this.map = null;
    this.trash = null;
    this.meta = null;
    this.roster = null;
  }

  // ── classification ─────────────────────────────────────────────────

  classify(file: TAbstractFile): EntryKind | null {
    if (
      !file.path ||
      file.path.startsWith(".obsidian/") ||
      file.path === ".obsidian" ||
      // Local-only conflict backups produced by the bind/connect
      // "server wins, back up local" path (invariant I4). These must
      // NEVER enter the manifest or sync to peers — they exist solely
      // so the user can recover their pre-merge local content on THIS
      // device. The name pattern is `<path>.local-backup-<docId>.md`.
      isLocalBackupPath(file.path)
    ) {
      return null;
    }
    if (file instanceof TFolder) return "folder";
    if (file instanceof TFile) {
      if (file.extension === "md") return "file";
      if (CANVAS_EXTENSIONS.has(file.extension)) return "canvas";
      if (ATOMIC_TEXT_EXTENSIONS.has(file.extension)) return "text";
      return "binary";
    }
    return null;
  }

  private sessionKindOf(kind: EntryKind): SessionKind | null {
    if (kind === "file" || kind === "canvas" || kind === "text") return kind;
    return null;
  }

  // ── reconcile ──────────────────────────────────────────────────────

  // Serialised entry point. If a reconcile is already running, the
  // caller waits for it and then a fresh one starts so any changes the
  // first pass missed (because they landed mid-walk) get picked up by
  // the second.
  private async runReconcile(): Promise<void> {
    if (this.reconcileInFlight) {
      // Chain: wait for the current one, then run again.
      try {
        await this.reconcileInFlight;
      } catch {
        /* the in-flight reconcile logs its own errors */
      }
    }
    let p!: Promise<void>;
    p = (async () => {
      try {
        await this.reconcile();
      } finally {
        // Clear before returning so a follow-up runReconcile() schedules
        // a fresh pass instead of waiting on the resolved promise.
        if (this.reconcileInFlight === p) this.reconcileInFlight = null;
      }
    })();
    this.reconcileInFlight = p;
    await p;
  }

  private async reconcile(): Promise<void> {
    if (!this.map || !this.ydoc) return;
    if (this.deps.sessionManager.isReadOnly()) {
      log.info("sync", "reconcile: read-only mode, skipping local writes");
    }

    // Walk local vault.
    const localPaths = new Set<string>();
    const allLocal: TAbstractFile[] = [];
    this.walk(this.deps.app.vault.getRoot(), allLocal);
    for (const f of allLocal) localPaths.add(f.path);

    // Manifest → local: materialise entries we don't have locally.
    // Binaries fan out with parallelism cap; the rest run sequentially.
    const binariesToDownload: Array<{ path: string; entry: ManifestEntry }> = [];
    for (const [path, entry] of this.map.entries()) {
      if (localPaths.has(path)) {
        // Already have it locally — open the session so peers' edits
        // flow through in the background, whether or not the file is
        // open in an editor.
        // v2.1.x: markdown ("file") now ALSO attaches eagerly (was
        // canvas/atomic only) so every markdown file syncs in the
        // background even when never opened in a CM editor (e.g. a note
        // rendered by Kanban in its own view).
        // TODO: cap background sessions (connection pool) for large
        // vaults — Phase 7.
        const sk = this.sessionKindOf(entry.kind);
        if (sk) {
          void this.deps.sessionManager.attach(path, sk, entry.id);
        }
        continue;
      }
      if (entry.kind === "binary") {
        binariesToDownload.push({ path, entry });
        continue;
      }
      await this.materialise(path, entry);
    }

    if (binariesToDownload.length > 0) {
      await this.downloadBinaries(binariesToDownload);
    }

    // Local → manifest: anything local not yet known.
    if (!this.deps.sessionManager.isReadOnly()) {
      const newBinaries: Array<{ file: TFile; entry: ManifestEntry; path: string }> = [];
      // BUG 2 — files to honor a deletion tombstone for. A local file
      // present but NOT in the manifest is normally re-registered. But if
      // a peer deleted it (manifest delete + trash tombstone), B may still
      // have it on disk and would otherwise resurrect it. If the path is
      // in trash at reconcile time, that's an un-cleared tombstone (a
      // genuine re-creation clears the tombstone in onLocalCreate, so a
      // re-created file's path is never in trash here) → delete it locally
      // instead of registering. The 30-day purge bounds the window.
      const tombstonedLocal: TAbstractFile[] = [];
      const CHUNK = 200;
      for (let i = 0; i < allLocal.length; i += CHUNK) {
        const slice = allLocal.slice(i, i + CHUNK);
        // Pre-compute binary hashes outside the transaction (async).
        const additions: Array<{ path: string; entry: ManifestEntry; file: TFile | null }> = [];
        for (const file of slice) {
          if (this.map.has(file.path)) continue;
          // BUG 2 — honor the deletion tombstone before registering.
          if (this.hasTrashTombstone(file.path)) {
            tombstonedLocal.push(file);
            continue;
          }
          const kind = this.classify(file);
          if (!kind) continue;
          if (kind === "binary" && file instanceof TFile) {
            // Defer binary registration to a second pass after upload.
            newBinaries.push({
              file,
              path: file.path,
              entry: { kind, id: uuid(), addedAt: Date.now() },
            });
            continue;
          }
          additions.push({
            path: file.path,
            entry: { kind, id: uuid(), addedAt: Date.now() },
            file: file instanceof TFile ? file : null,
          });
        }
        this.ydoc.transact(() => {
          for (const a of additions) this.map!.set(a.path, a.entry);
        });
        for (const a of additions) {
          const sk = this.sessionKindOf(a.entry.kind);
          if (sk && a.file) {
            // origin="local" (I3): these are local files NOT present in
            // the manifest — we just minted a fresh UUID and added the
            // entry above, so `doc:<id>` is a brand-new room, empty by
            // construction. (Files that DID already exist in the manifest
            // took the localPaths.has → attach path earlier, which is
            // "remote": their room may hold peer content.) Safe to seed.
            void this.deps.sessionManager.attach(a.path, sk, a.entry.id, "local");
          }
        }
        if (i + CHUNK < allLocal.length) {
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      }
      // Upload binaries discovered locally.
      for (const b of newBinaries) void this.uploadBinaryAndRegister(b.file, b.entry);

      // BUG 2 — honor deletion tombstones: a peer deleted these, we
      // still have them on disk. Delete locally (suppressed so it
      // doesn't echo back into the manifest) instead of resurrecting.
      for (const file of tombstonedLocal) {
        await this.deleteLocalTombstoned(file);
      }
    }

    if (this.trash) {
      const purged = purgeOldTrash(this.ydoc, this.trash);
      if (purged > 0) log.info("trash", `purged ${purged} expired trash entries`);
    }

    log.info(
      "sync",
      `reconcile complete: manifest has ${this.map.size} entries, trash ${this.trash?.size ?? 0}`,
    );
  }

  private walk(folder: TFolder, out: TAbstractFile[]) {
    for (const child of folder.children) {
      out.push(child);
      if (child instanceof TFolder) this.walk(child, out);
    }
  }

  // ── BUG 2 — deletion-tombstone helpers ──────────────────────────────

  // True if the trash map holds a tombstone for this path. The trash is
  // keyed by docId, not path, so we scan values. A path in trash means
  // "deleted by some peer, not yet re-created" — onLocalCreate clears
  // the tombstone on a genuine re-creation, so a re-created file's path
  // is never here. The 30-day purge bounds how long a stale tombstone
  // can keep a re-appearing local file from registering.
  private hasTrashTombstone(path: string): boolean {
    if (!this.trash) return false;
    for (const entry of this.trash.values()) {
      if (entry.path === path) return true;
    }
    return false;
  }

  // Remove every trash tombstone whose path matches `path`. Called from
  // onLocalCreate when the user intentionally re-creates a file at a
  // previously-deleted path: the tombstone is now stale and must not
  // cause reconcile (point 1) to auto-delete the fresh file. Runs in a
  // single transaction.
  private clearTrashTombstones(path: string): void {
    if (!this.trash || !this.ydoc) return;
    const ids: string[] = [];
    for (const [id, entry] of this.trash.entries()) {
      if (entry.path === path) ids.push(id);
    }
    if (ids.length === 0) return;
    this.ydoc.transact(() => {
      for (const id of ids) this.trash!.delete(id);
    });
    log.info("trash", `cleared ${ids.length} stale tombstone(s) for re-created ${path}`);
  }

  // Delete a local file that a peer already deleted (its path is in
  // trash) — the reconcile backstop for the delete-resurrection race.
  // Suppressed via remoteApplyPaths so onLocalDelete doesn't re-fire a
  // manifest delete / re-trash. Also tears down any bound session.
  private async deleteLocalTombstoned(file: TAbstractFile): Promise<void> {
    const path = file.path;
    this.deps.remoteApplyPaths.add(path);
    try {
      await this.deps.sessionManager.detach(path);
      await this.deps.app.vault.delete(file, true);
      log.info(
        "sync",
        `reconcile: ${path} is tombstoned (deleted by a peer) — removed locally instead of re-registering`,
      );
    } catch (err) {
      log.warn("sync", `reconcile: failed to delete tombstoned ${path}`, err);
    } finally {
      setTimeout(
        () => this.deps.remoteApplyPaths.delete(path),
        SUPPRESS_HOLD_MS,
      );
    }
  }

  // Eager binary download with a parallelism cap. Status bar shows
  // progress as "syncing N/M binaries".
  private async downloadBinaries(
    items: Array<{ path: string; entry: ManifestEntry }>,
  ): Promise<void> {
    const client = this.deps.binaryClient();
    if (!client) {
      log.warn("blob", "downloadBinaries: no blob client");
      return;
    }
    const total = items.length;
    let done = 0;
    let cursor = 0;
    this.deps.onDownloadProgress(`syncing 0/${total} binaries`);

    const next = async (): Promise<void> => {
      while (cursor < items.length) {
        const idx = cursor++;
        const { path, entry } = items[idx];
        try {
          await this.materialiseBinary(path, entry, client);
        } catch (err) {
          log.warn("blob", `download ${path} failed`, err);
        }
        done++;
        // While the batch runs, show progress; when it finishes, fall
        // through to a "pending" label if any blob parked (FIX B), else
        // clear.
        if (done < total) {
          this.deps.onDownloadProgress(`syncing ${done}/${total} binaries`);
        } else {
          this.deps.onDownloadProgress(
            this.pendingDownloads.size > 0
              ? `${this.pendingDownloads.size} binaries pending`
              : null,
          );
        }
      }
    };
    const workers = Math.min(MAX_PARALLEL_DOWNLOADS, items.length);
    await Promise.all(Array.from({ length: workers }, () => next()));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  // FIX B + D — download a blob with bounded retry and integrity check.
  // Returns the verified bytes, or null if every attempt was exhausted
  // (the path has been parked in `pendingDownloads` for the slow-path
  // sweep) OR the blob is poison (hash mismatch — logged, not parked).
  //
  // `attempts` controls the in-call retry budget. The fast path (initial
  // reconcile / live manifest change) uses the full backoff ladder so a
  // freshly-added image that's mid-upload resolves within ~15s without
  // ever touching the slow path. The slow-path sweep passes attempts=1:
  // the 30s sweep interval already provides the retry cadence, so we
  // don't want each parked blob to re-burn the full backoff on every
  // sweep (which would serialise into minutes).
  //
  // Retry policy per error:
  //   BlobNotFoundError (404)  → retry: uploader's PUT is in flight
  //   network error / 5xx      → retry: transient
  //   BlobHashMismatchError    → POISON: bail immediately, do NOT park
  //                              (re-GETting the same hash can't help)
  //   BlobAuthError            → park but don't spin: the socket-level
  //                              auth handler (FIX A) owns recovery
  private async downloadWithRetry(
    path: string,
    entry: ManifestEntry,
    client: BinaryClient,
    attempts: number = DOWNLOAD_RETRY_ATTEMPTS,
  ): Promise<Uint8Array | null> {
    if (!entry.hash) return null;
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        // download() verifies sha256(bytes) === entry.hash internally.
        const bytes = await client.download(entry.hash);
        // Success — clear any prior parked retry for this path.
        if (this.pendingDownloads.delete(path)) {
          this.deps.onDownloadProgress(
            this.pendingDownloads.size > 0
              ? `${this.pendingDownloads.size} binaries pending`
              : null,
          );
        }
        if (attempt > 0) {
          log.info("blob", `download ${path} succeeded on attempt ${attempt + 1}`);
        }
        return bytes;
      } catch (err) {
        lastErr = err;
        if (err instanceof BlobHashMismatchError) {
          // Poison: corrupted/wrong bytes for this content hash. More
          // GETs return the same wrong object. Give up; don't park.
          log.error(
            "blob",
            `download ${path} POISON (hash mismatch) — not retrying`,
            err,
          );
          this.pendingDownloads.delete(path);
          return null;
        }
        const name = err instanceof Error ? err.name : "";
        if (name === "BlobAuthError") {
          // Socket-level auth handler (FIX A) owns recovery; per-blob
          // retry would just spin against a paused token. Park (so a
          // post-recovery sweep re-tries it) but stop looping now.
          log.warn("blob", `download ${path} blocked by auth — deferring`, err);
          this.parkPending(path, entry);
          return null;
        }
        // Retryable (404 / network / 5xx). Back off, then loop —
        // unless that was the last attempt.
        if (attempt < attempts - 1) {
          const delay = Math.min(
            DOWNLOAD_RETRY_BASE_MS * 2 ** attempt,
            DOWNLOAD_RETRY_MAX_MS,
          );
          this.deps.debug(
            `[collab] download ${path} attempt ${attempt + 1} failed; retry in ${delay}ms`,
            err,
          );
          await this.sleep(delay);
        }
      }
    }
    // Attempts exhausted — park for the slow-path sweep.
    log.warn(
      "blob",
      `download ${path} failed after ${attempts} attempt(s) — parking for retry`,
      lastErr,
    );
    this.parkPending(path, entry);
    return null;
  }

  // Add a path to the pending-retry set and refresh the status-bar
  // pending count.
  private parkPending(path: string, entry: ManifestEntry): void {
    this.pendingDownloads.set(path, entry);
    this.deps.onDownloadProgress(
      this.pendingDownloads.size > 0
        ? `${this.pendingDownloads.size} binaries pending`
        : null,
    );
  }

  // FIX B — slow-path drain of `pendingDownloads`. Serialised (one blob
  // at a time, lower priority than the initial reconcile fan-out) and
  // single-flighted so the interval and a `synced` event don't race.
  // Re-runs materialiseBinary, which re-enters downloadWithRetry; a
  // success removes the path from the set, a continued failure re-parks
  // it for the next sweep.
  private async sweepPendingDownloads(trigger: string): Promise<void> {
    if (this.pendingSweepInFlight) return;
    if (this.pendingDownloads.size === 0) return;
    const client = this.deps.binaryClient();
    if (!client) return;
    this.pendingSweepInFlight = true;
    try {
      // Snapshot: materialiseBinary mutates pendingDownloads as it goes.
      const snapshot = Array.from(this.pendingDownloads.entries());
      log.info(
        "blob",
        `pending sweep (${trigger}): retrying ${snapshot.length} stranded binaries`,
      );
      for (const [path, entry] of snapshot) {
        // The manifest may have moved on (deleted / re-hashed) while the
        // blob was stranded. Re-check before spending a download.
        const current = this.map?.get(path);
        if (!current || current.kind !== "binary" || current.hash !== entry.hash) {
          this.pendingDownloads.delete(path);
          continue;
        }
        try {
          // attempts=1: the sweep cadence IS the retry interval; don't
          // re-burn the full backoff ladder per parked blob per tick.
          await this.materialiseBinary(path, entry, client, 1);
        } catch (err) {
          log.warn("blob", `pending sweep: ${path} still failing`, err);
        }
      }
      this.deps.onDownloadProgress(
        this.pendingDownloads.size > 0
          ? `${this.pendingDownloads.size} binaries pending`
          : null,
      );
    } finally {
      this.pendingSweepInFlight = false;
    }
  }

  // True if `err` is Obsidian's "File already exists." rejection. We
  // can't switch on an error code — Obsidian throws plain `Error`
  // instances with an English message — so we string-match. Tolerant of
  // trailing punctuation / casing.
  private isAlreadyExistsError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /file already exists/i.test(msg);
  }

  private async materialiseBinary(
    path: string,
    entry: ManifestEntry,
    client: BinaryClient,
    // Retry budget for the download. Default = full backoff ladder
    // (fast path). The slow-path sweep passes 1 so a parked blob does a
    // single probe per sweep tick instead of re-burning the full ladder.
    attempts: number = DOWNLOAD_RETRY_ATTEMPTS,
  ): Promise<void> {
    if (!entry.hash) {
      log.warn("blob", `materialiseBinary ${path}: no hash on entry`);
      return;
    }
    this.deps.remoteApplyPaths.add(path);
    try {
      await this.ensureFolderExists(path);
      const existing = this.deps.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFolder) {
        log.warn(
          "sync",
          `materialiseBinary: ${path} is a local folder; manifest says binary — skipping`,
        );
        return;
      }
      if (existing instanceof TFile) {
        // Hash check: if local bytes already match, no work to do.
        try {
          const local = await this.deps.app.vault.readBinary(existing);
          const localHash = await sha256Hex(new Uint8Array(local));
          if (localHash === entry.hash) {
            this.deps.debug(`[collab] materialiseBinary: ${path} already matches manifest hash`);
            if (this.pendingDownloads.delete(path)) {
              this.deps.onDownloadProgress(
                this.pendingDownloads.size > 0
                  ? `${this.pendingDownloads.size} binaries pending`
                  : null,
              );
            }
            return;
          }
        } catch (err) {
          log.warn("blob", `materialiseBinary hash check failed for ${path}`, err);
        }
        // Local differs — overwrite with manifest bytes. Retry-wrapped
        // + hash-verified; null means parked/poison, so leave the
        // existing (stale) file untouched rather than half-writing.
        const bytes = await this.downloadWithRetry(path, entry, client, attempts);
        if (!bytes) return;
        const buf = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        await this.deps.app.vault.modifyBinary(existing, buf);
        log.info("sync", `materialise: binary ${path} updated (${bytes.byteLength}b)`);
        return;
      }
      const bytes = await this.downloadWithRetry(path, entry, client, attempts);
      if (!bytes) return;
      const buf = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      try {
        await this.deps.app.vault.createBinary(path, buf);
        log.info("sync", `materialise: binary ${path} (${bytes.byteLength}b)`);
      } catch (err) {
        if (this.isAlreadyExistsError(err)) {
          this.deps.debug(`[collab] materialiseBinary: ${path} appeared during create — skipping`);
        } else {
          throw err;
        }
      }
    } finally {
      setTimeout(
        () => this.deps.remoteApplyPaths.delete(path),
        SUPPRESS_HOLD_MS,
      );
    }
  }

  // Create-only-if-missing for non-binary entries. The "File already
  // exists" log spam in 1.0.2 fired here when `getAbstractFileByPath`
  // returned null (Obsidian's in-memory cache hadn't picked up the new
  // file yet) but the underlying disk file genuinely existed — e.g.
  // case-insensitive filesystem collision, or a peer's manifest add
  // arriving microseconds after a local vault.create fired but before
  // its TFile registration completed. The race window is small but real
  // (one user report per session on macOS). Treat "already exists" as
  // a no-op with a debug log — anything else still escalates.
  private async safeCreateIfMissing(
    path: string,
    body: string,
    binary: boolean = false,
  ): Promise<void> {
    const existing = this.deps.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) {
      log.warn(
        "sync",
        `materialise: ${path} is a local folder; manifest says file — skipping create`,
      );
      return;
    }
    if (existing instanceof TFile) {
      // Already there — nothing to materialise. Session attach happens
      // separately in the caller.
      this.deps.debug(`[collab] materialise: ${path} already present locally`);
      return;
    }
    try {
      if (binary) {
        // Unused for now — binary path uses createBinary directly.
        return;
      }
      await this.deps.app.vault.create(path, body);
    } catch (err) {
      if (this.isAlreadyExistsError(err)) {
        this.deps.debug(`[collab] materialise: ${path} already exists on disk — no-op`);
        return;
      }
      throw err;
    }
  }

  private async materialise(path: string, entry: ManifestEntry): Promise<void> {
    this.deps.remoteApplyPaths.add(path);
    try {
      if (entry.kind === "folder") {
        const existing = this.deps.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
          log.warn(
            "sync",
            `materialise: ${path} is a local file; manifest says folder — skipping`,
          );
          return;
        }
        if (!existing) {
          try {
            await this.deps.app.vault.createFolder(path);
          } catch (err) {
            if (!this.isAlreadyExistsError(err)) throw err;
          }
        }
        return;
      }
      await this.ensureFolderExists(path);
      if (entry.kind === "file") {
        await this.safeCreateIfMissing(path, "");
        // v2.1.x: attach the markdown session eagerly so a peer-created
        // note syncs in the background even if the user never opens it
        // in a CM editor (e.g. a Kanban-rendered note).
        // TODO: cap background sessions (connection pool) for large
        // vaults — Phase 7.
        const sk = this.sessionKindOf(entry.kind);
        if (sk) await this.deps.sessionManager.attach(path, sk, entry.id);
        return;
      }
      if (entry.kind === "canvas" || entry.kind === "text") {
        await this.safeCreateIfMissing(
          path,
          entry.kind === "canvas" ? "{}" : "",
        );
        const sk = this.sessionKindOf(entry.kind);
        if (sk) await this.deps.sessionManager.attach(path, sk, entry.id);
        return;
      }
      // binary handled separately by materialiseBinary
    } catch (err) {
      log.warn("sync", `materialise failed for ${path}`, err);
    } finally {
      setTimeout(
        () => this.deps.remoteApplyPaths.delete(path),
        SUPPRESS_HOLD_MS,
      );
    }
  }

  private async ensureFolderExists(filePath: string): Promise<void> {
    const slash = filePath.lastIndexOf("/");
    if (slash <= 0) return;
    const folder = filePath.substring(0, slash);
    if (this.deps.app.vault.getAbstractFileByPath(folder)) return;
    try {
      await this.deps.app.vault.createFolder(folder);
    } catch (err) {
      if (!/already exists/i.test(String(err))) throw err;
    }
  }

  // ── local vault → manifest ─────────────────────────────────────────

  onLocalCreate(file: TAbstractFile): void {
    if (!this.map) return;
    if (this.deps.sessionManager.isReadOnly()) return;
    if (this.deps.remoteApplyPaths.has(file.path)) return;
    const kind = this.classify(file);
    if (!kind) return;
    if (this.map.has(file.path)) {
      log.info("sync", `vault.create: already in manifest ${file.path}`);
      return;
    }
    // BUG 2 — intentional re-creation at a previously-deleted path. The
    // old tombstone is now stale; clear it so reconcile's tombstone
    // backstop (which would otherwise delete this fresh file) doesn't
    // fire, and so the file registers + syncs as a brand-new file.
    this.clearTrashTombstones(file.path);
    log.info("sync", `vault.create: ${file.path} (${kind})`);
    if (kind === "binary" && file instanceof TFile) {
      // Mint id now (so we have a stable identity), then upload bytes
      // and register the entry with hash + size only after the upload
      // succeeds. If upload fails we never insert into the manifest,
      // so peers don't see a binary they can't fetch.
      const entry: ManifestEntry = {
        kind: "binary",
        id: uuid(),
        addedAt: Date.now(),
      };
      void this.uploadBinaryAndRegister(file, entry);
      return;
    }
    const id = uuid();
    const entry: ManifestEntry = { kind, id, addedAt: Date.now() };
    this.map.set(file.path, entry);
    const sk = this.sessionKindOf(kind);
    if (sk && file instanceof TFile) {
      // v2.0.0: just kick attach(). When it reaches `bound`, SessionManager
      // fires sessionReady via emitSessionReady (wired in main.ts);
      // LiveViewManager hears it and re-runs its refresh, which picks
      // up the new session and installs the binding into whatever leaf
      // is already showing this file. No need for an explicit chained
      // bindEditorIfReady — LiveViewManager replaces that entire
      // pipeline.
      //
      // origin="local" (I3): the user just created this file locally and
      // we just minted+added its manifest entry above, so the server
      // room `doc:<id>` is brand-new and empty BY CONSTRUCTION. This is
      // the ONLY attach allowed to seed local disk content into ytext.
      void this.deps.sessionManager.attach(file.path, sk, id, "local");
    }
  }

  onLocalModify(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    if (!this.map) return;
    if (this.deps.sessionManager.isReadOnly()) return;
    if (this.deps.remoteApplyPaths.has(file.path)) return;
    // ── markdown background disk→Y capture (v2.1.x) ───────────────────
    // Previously markdown returned early here ("syncs via editor
    // binding"). With eager whole-vault sessions, a disk write by
    // ANOTHER plugin (e.g. Kanban) to a markdown file that is NOT open
    // in a CM editor must be captured into ytext so peers see it.
    //
    // Routing:
    //   - remoteApplyPaths.has → already returned above (our own
    //     ytext→disk write echoing back; suppressed).
    //   - editor open on this path → DEFER. The yedit binding owns
    //     disk↔Y for open files; running the diff path too would fight
    //     it. (Absent hasEditorFor dep ⇒ assume editor ⇒ defer.)
    //   - no session bound → return (shouldn't happen with eager attach;
    //     guard against a race where modify fires before attach binds).
    //   - otherwise → session.applyDiskUpdate() (diff disk→ytext).
    if (file.extension === "md") {
      const editorOpen = this.deps.hasEditorFor
        ? this.deps.hasEditorFor(file.path)
        : true;
      if (editorOpen) return;
      const session = this.deps.sessionManager.getBound(file.path);
      if (!session || session.sessionKind !== "file") return;
      void (session as unknown as { applyDiskUpdate: () => Promise<void> }).applyDiskUpdate();
      return;
    }
    const kind = this.classify(file);
    if (kind === "canvas" || kind === "text") {
      const session = this.deps.sessionManager.getBound(file.path);
      if (!session) {
        // Not yet bound — manifest entry should exist; attach will
        // be kicked off below.
        const entry = this.map.get(file.path);
        if (entry) {
          const sk = this.sessionKindOf(entry.kind);
          if (sk) void this.deps.sessionManager.attach(file.path, sk, entry.id);
        }
        return;
      }
      if (kind === "canvas") {
        void (session as unknown as { applyDiskUpdate: () => Promise<void> }).applyDiskUpdate();
      } else {
        void (session as unknown as { applyDiskUpdate: () => Promise<void> }).applyDiskUpdate();
      }
      return;
    }
    if (kind === "binary") {
      const existing = this.map.get(file.path);
      const entry: ManifestEntry =
        existing ?? { kind: "binary", id: uuid(), addedAt: Date.now() };
      void this.uploadBinaryAndRegister(file, entry);
    }
  }

  async onLocalRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!this.map || !this.ydoc) return;
    if (this.deps.sessionManager.isReadOnly()) return;
    if (
      this.deps.remoteApplyPaths.has(file.path) ||
      this.deps.remoteApplyPaths.has(oldPath)
    ) {
      return;
    }
    const existing = this.map.get(oldPath);
    if (!existing) {
      // Pre-existing local file we never registered — treat as create.
      this.onLocalCreate(file);
      return;
    }
    // Atomic relabel — same id, same Y.Doc room.
    this.ydoc.transact(() => {
      this.map!.delete(oldPath);
      this.map!.set(file.path, { ...existing });
    });
    await this.deps.sessionManager.handleRename(oldPath, file.path);
    log.info("sync", `vault.rename: ${oldPath} → ${file.path}`);
  }

  // Entry point from the vault `delete` event. Instead of propagating
  // immediately we BUFFER, so a burst of deletes (a moved folder, a vault
  // path change) is judged as a batch by flushDeletes — and a suspiciously
  // large batch is held for user confirmation rather than nuking everyone.
  async onLocalDelete(file: TAbstractFile): Promise<void> {
    if (!this.map || !this.trash || !this.ydoc) return;
    if (this.deps.sessionManager.isReadOnly()) return;
    if (this.deps.remoteApplyPaths.has(file.path)) return;
    const tracked = this.map.get(file.path);
    if (!tracked) return; // not tracked → nothing to do
    this.deleteBuffer.set(file.path, { file, id: tracked.id });
    if (this.deleteFlushTimer) clearTimeout(this.deleteFlushTimer);
    this.deleteFlushTimer = setTimeout(() => {
      void this.flushDeletes();
    }, DELETE_HOLD_MS);
  }

  // Decide a buffered batch of deletes. Under the threshold → propagate
  // normally. Over it → hand off to the UI guard (default: keep).
  private async flushDeletes(): Promise<void> {
    this.deleteFlushTimer = null;
    const batch = Array.from(this.deleteBuffer.values());
    this.deleteBuffer.clear();
    if (batch.length === 0) return;

    if (batch.length > MASS_DELETE_THRESHOLD) {
      const paths = batch.map((b) => b.file.path);
      log.warn(
        "sync",
        `mass-delete guard tripped: ${paths.length} files deleted at once — holding for confirmation (NOT propagated)`,
      );
      const doDelete = () => {
        for (const b of batch) void this.applyDeleteNow(b.file, b.id);
      };
      const keep = () => {
        void this.keepDeleted(batch);
      };
      if (this.deps.onMassDelete) {
        this.deps.onMassDelete(paths, doDelete, keep);
      } else {
        // No UI wired — never auto-propagate a suspicious bulk delete.
        keep();
      }
      return;
    }

    for (const b of batch) await this.applyDeleteNow(b.file, b.id);
  }

  // "Keep" branch of the guard: we never touched the manifest, so the
  // entries + server content are intact. Re-create the local files that
  // Obsidian reported as deleted, so the accidental move is fully undone.
  private async keepDeleted(
    batch: Array<{ file: TAbstractFile; id: string }>,
  ): Promise<void> {
    if (!this.map) return;
    let restored = 0;
    for (const { file, id } of batch) {
      const entry = this.map.get(file.path);
      if (!entry || entry.id !== id) continue; // gone or recreated → skip
      try {
        await this.materialise(file.path, entry);
        restored++;
      } catch (err) {
        log.warn("sync", `restore-after-keep failed for ${file.path}`, err);
      }
    }
    log.info(
      "sync",
      `mass-delete guard: kept + restored ${restored}/${batch.length} files`,
    );
    new Notice(
      `Concord: kept ${restored} file(s) — the bulk deletion was NOT sent to collaborators.`,
      8000,
    );
  }

  // Actually apply a single deletion: wipe the room, tombstone in trash,
  // drop the manifest entry. (Formerly the body of onLocalDelete.)
  private async applyDeleteNow(
    file: TAbstractFile,
    expectedId: string,
  ): Promise<void> {
    if (!this.map || !this.trash || !this.ydoc) return;
    const entry = this.map.get(file.path);
    if (!entry) return;
    // The path was re-created with a fresh identity between buffering and
    // now → this is not the file we were asked to delete. Don't touch it.
    if (entry.id !== expectedId) {
      log.info("sync", `delete skipped (path recreated): ${file.path}`);
      return;
    }
    log.info("sync", `vault.delete: ${file.path} (${entry.kind}, id=${entry.id})`);

    // Wipe + tear down the session if it has content.
    const sessionKind = this.sessionKindOf(entry.kind);
    if (sessionKind) {
      const bound = this.deps.sessionManager.getBound(file.path);
      if (bound) {
        bound.wipe();
        // Hold a brief moment so the wipe transaction flushes to the
        // server before we tear down the provider. Background; we
        // don't need to block the delete handler on it.
        const path = file.path;
        setTimeout(() => {
          void this.deps.sessionManager.detach(path);
        }, 1500);
      } else {
        // Not currently bound — spin up a transient session, wipe,
        // hold for flush, tear down. Fire-and-forget.
        void this.transientWipe(entry.id, sessionKind);
      }
    }

    // Atomic manifest mutation: delete + trash.set.
    this.ydoc.transact(() => {
      this.map!.delete(file.path);
      const trashEntry: TrashEntry = {
        id: entry.id,
        path: file.path,
        kind: entry.kind,
        deletedAt: Date.now(),
        docId: entry.id,
        hash: entry.hash,
      };
      this.trash!.set(entry.id, trashEntry);
    });

    // Drop the merge-base snapshot for this file so deleting + recreating
    // a file at the same path (which mints a fresh docId anyway) never
    // resurrects a stale base. Keyed by docId; fire-and-forget.
    if (this.sessionKindOf(entry.kind) === "file") {
      void DiskBuffer.shared().delete(entry.id);
    }
  }

  // Spin up a session just long enough to wipe its room, then destroy.
  // Used when a file is deleted that has never been opened locally —
  // there's no live session to wipe through.
  private async transientWipe(
    docId: string,
    kind: SessionKind,
  ): Promise<void> {
    const tempPath = `__transient_wipe_${docId}`;
    try {
      const session = await this.deps.sessionManager.attach(
        tempPath,
        kind,
        docId,
      );
      if (!session) return;
      session.wipe();
      // Hold long enough for the empty-state update to flush
      // through Hocuspocus's debounced server-side store.
      await new Promise<void>((r) => setTimeout(r, 1500));
    } catch (err) {
      log.warn("session", `transientWipe failed for ${docId}`, err);
    } finally {
      await this.deps.sessionManager.detach(tempPath);
    }
  }

  // Upload bytes via HTTP and either register or update the manifest
  // entry once the upload completes.
  private async uploadBinaryAndRegister(
    file: TFile,
    entryDraft: ManifestEntry,
  ): Promise<void> {
    if (!this.map) return;
    const client = this.deps.binaryClient();
    if (!client) {
      log.warn("blob", `uploadBinary: no blob client, skipping ${file.path}`);
      return;
    }
    try {
      const buf = await this.deps.app.vault.readBinary(file);
      const bytes = new Uint8Array(buf);
      if (buf.byteLength > LARGE_FILE_WARN_BYTES) {
        new Notice(
          `Concord: ${file.path} is ${Math.floor(buf.byteLength / 1024 / 1024)} MB — sync may take a while`,
          5000,
        );
      }
      const hash = await sha256Hex(bytes);
      // Skip if entry already matches.
      const existing = this.map.get(file.path);
      if (existing && existing.hash === hash) {
        this.deps.debug(`[collab] uploadBinary: ${file.path} unchanged`);
        return;
      }
      const exists = await client.exists(hash).catch(() => false);
      if (!exists) {
        await client.upload(bytes, hash);
      }
      const mime = mimeFromExtension(file.extension);
      const entry: ManifestEntry = {
        ...entryDraft,
        hash,
        size: buf.byteLength,
        mime,
      };
      this.map.set(file.path, entry);
      log.info(
        "blob",
        `uploadBinary: ${file.path} (${buf.byteLength}b, hash=${hash.slice(0, 12)}…)`,
      );
    } catch (err) {
      log.warn("blob", `uploadBinary failed for ${file.path}`, err);
    }
  }

  // ── remote manifest → local vault ──────────────────────────────────

  private async onManifestChange(
    event: Y.YMapEvent<ManifestEntry>,
  ): Promise<void> {
    if (!this.map) return;
    const deletes: string[] = [];
    const adds: Array<{ path: string; entry: ManifestEntry }> = [];
    const updates: Array<{ path: string; entry: ManifestEntry }> = [];
    event.changes.keys.forEach((change, key) => {
      if (change.action === "delete") deletes.push(key);
      else if (change.action === "add") {
        const e = this.map?.get(key);
        if (e) adds.push({ path: key, entry: e });
      } else if (change.action === "update") {
        const e = this.map?.get(key);
        if (e) updates.push({ path: key, entry: e });
      }
    });
    if (deletes.length || adds.length || updates.length) {
      log.info(
        "sync",
        `manifestChange: +${adds.length} ~${updates.length} -${deletes.length}`,
      );
    }

    // 1 delete + 1 add in the same event with matching ids = rename.
    if (deletes.length === 1 && adds.length === 1) {
      const oldPath = deletes[0];
      const newPath = adds[0].path;
      const newEntry = adds[0].entry;
      // Try to match by id with the prior local manifest snapshot —
      // we no longer have it, but path-level rename via vault is the
      // common case and Obsidian re-uses the same TFile.
      const local = this.deps.app.vault.getAbstractFileByPath(oldPath);
      if (local) {
        await this.applyRemoteRename(oldPath, newPath, newEntry);
        return;
      }
      // Local doesn't have the old file (e.g. peer deleted+recreated
      // with new id, but path is the same path we never had). Treat
      // as delete + add.
    }

    for (const path of deletes) await this.applyRemoteDelete(path);
    for (const a of adds) {
      if (a.entry.kind === "binary") {
        const client = this.deps.binaryClient();
        if (client) {
          await this.materialiseBinary(a.path, a.entry, client);
        }
      } else {
        await this.materialise(a.path, a.entry);
      }
    }
    // Updates: a binary's hash may have changed (re-upload by a peer),
    // or a manifest entry was modified in place. materialiseBinary
    // handles both the "local exists but differs → overwrite" and the
    // "missing locally → create" cases, with the in-call retry +
    // hash-verify wrapper (FIX B/D). Routing through it means a peer's
    // re-upload that 404s briefly (their PUT still in flight) is parked
    // and retried instead of stranding the stale local copy.
    for (const u of updates) {
      if (u.entry.kind === "binary") {
        const client = this.deps.binaryClient();
        if (client) {
          await this.materialiseBinary(u.path, u.entry, client);
        }
      }
    }
  }

  private async applyRemoteRename(
    oldPath: string,
    newPath: string,
    entry: ManifestEntry,
  ): Promise<void> {
    const local = this.deps.app.vault.getAbstractFileByPath(oldPath);
    if (!local) {
      await this.materialise(newPath, entry);
      return;
    }
    this.deps.remoteApplyPaths.add(oldPath);
    this.deps.remoteApplyPaths.add(newPath);
    try {
      await this.ensureFolderExists(newPath);
      await this.deps.app.fileManager.renameFile(local, newPath);
      await this.deps.sessionManager.handleRename(oldPath, newPath);
      log.info("sync", `remote rename: ${oldPath} → ${newPath}`);
    } catch (err) {
      log.warn("sync", "remote rename failed", oldPath, newPath, err);
    } finally {
      setTimeout(() => {
        this.deps.remoteApplyPaths.delete(oldPath);
        this.deps.remoteApplyPaths.delete(newPath);
      }, SUPPRESS_HOLD_MS);
    }
  }

  private async applyRemoteDelete(path: string): Promise<void> {
    const local = this.deps.app.vault.getAbstractFileByPath(path);
    // Tear down our session regardless — the room is being wiped by
    // the originator.
    await this.deps.sessionManager.detach(path);
    if (!local) return;
    this.deps.remoteApplyPaths.add(path);
    try {
      await this.deps.app.vault.delete(local, true);
      log.info("sync", `remote delete: ${path}`);
    } catch (err) {
      log.warn("sync", "remote delete failed", path, err);
    } finally {
      setTimeout(
        () => this.deps.remoteApplyPaths.delete(path),
        SUPPRESS_HOLD_MS,
      );
    }
  }
}
