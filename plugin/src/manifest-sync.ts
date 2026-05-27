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

import { MANIFEST_ROOM, mimeFromExtension, sha256Hex, uuid } from "./util";
import {
  PROTOCOL_VERSION,
  type EntryKind,
  type ManifestEntry,
  type SessionKind,
  type TrashEntry,
} from "./types";
import type { SessionManager } from "./session-manager";
import type { BinaryClient } from "./binary-client";
import { purgeOldTrash } from "./trash";

const CANVAS_EXTENSIONS = new Set(["canvas"]);
const ATOMIC_TEXT_EXTENSIONS = new Set(["base"]);
const SUPPRESS_HOLD_MS = 1000;

// Plugin warns at this size — doesn't block.
export const LARGE_FILE_WARN_BYTES = 50 * 1024 * 1024;

// Cap parallel binary downloads during reconcile so a vault with 50
// PDFs doesn't serialize and doesn't open 50 fetches at once.
const MAX_PARALLEL_DOWNLOADS = 4;

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
  debug: (...args: unknown[]) => void;
}

export class ManifestSync {
  private ydoc: Y.Doc | null = null;
  private map: Y.Map<ManifestEntry> | null = null;
  private trash: Y.Map<TrashEntry> | null = null;
  private meta: Y.Map<unknown> | null = null;
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

  constructor(private readonly deps: ManifestSyncDeps) {}

  isReady(): boolean {
    return this.map !== null;
  }
  getTrash(): Y.Map<TrashEntry> | null {
    return this.trash;
  }

  start(): void {
    const socket = this.deps.getSocket();
    if (!socket || this.provider) return;

    this.ydoc = new Y.Doc();
    this.map = this.ydoc.getMap<ManifestEntry>("files");
    this.trash = this.ydoc.getMap<TrashEntry>("trash");
    this.meta = this.ydoc.getMap<unknown>("meta");

    this.provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: MANIFEST_ROOM,
      document: this.ydoc,
      token: this.deps.authToken() || undefined,
    });
    this.provider.attach();

    this.persistence = new IndexeddbPersistence(
      `obsidian-collab::${this.deps.serverUrl()}::${MANIFEST_ROOM}`,
      this.ydoc,
    );

    this.provider.on("synced", () => {
      console.log(
        `[collab] manifest synced (${this.map?.size ?? 0} entries)`,
      );
      // Protocol gate
      const serverProtocol =
        (this.meta?.get("protocolVersion") as number | undefined) ?? 0;
      if (serverProtocol > PROTOCOL_VERSION) {
        console.warn(
          `[collab] server protocol v${serverProtocol} > ours v${PROTOCOL_VERSION} — entering read-only`,
        );
        this.deps.sessionManager.setReadOnly(true);
        return;
      }
      this.deps.sessionManager.setReadOnly(false);
      if (serverProtocol < PROTOCOL_VERSION) {
        this.meta?.set("protocolVersion", PROTOCOL_VERSION);
        console.log(
          `[collab] stamped manifest protocolVersion=${PROTOCOL_VERSION}`,
        );
      }
      void this.runReconcile();
    });

    this.provider.on(
      "authenticationFailed",
      (d: { reason: string }) => {
        console.error(`[collab] manifest auth failed: ${d.reason}`);
        new Notice(
          "Collab: server rejected the manifest connection (auth). Vault structure won't sync until you fix the token.",
        );
      },
    );

    this.mapObserver = (event) => void this.onManifestChange(event);
    this.map.observe(this.mapObserver);
  }

  async stop(): Promise<void> {
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
  }

  // ── classification ─────────────────────────────────────────────────

  classify(file: TAbstractFile): EntryKind | null {
    if (
      !file.path ||
      file.path.startsWith(".obsidian/") ||
      file.path === ".obsidian"
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
      console.log("[collab] reconcile: read-only mode, skipping local writes");
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
        // Already have it locally — if it's a canvas/atomic, make
        // sure the session is open so peers' edits flow through.
        const sk = this.sessionKindOf(entry.kind);
        if (sk && sk !== "file") {
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
      const CHUNK = 200;
      for (let i = 0; i < allLocal.length; i += CHUNK) {
        const slice = allLocal.slice(i, i + CHUNK);
        // Pre-compute binary hashes outside the transaction (async).
        const additions: Array<{ path: string; entry: ManifestEntry; file: TFile | null }> = [];
        for (const file of slice) {
          if (this.map.has(file.path)) continue;
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
            void this.deps.sessionManager.attach(a.path, sk, a.entry.id);
          }
        }
        if (i + CHUNK < allLocal.length) {
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      }
      // Upload binaries discovered locally.
      for (const b of newBinaries) void this.uploadBinaryAndRegister(b.file, b.entry);
    }

    if (this.trash) {
      const purged = purgeOldTrash(this.ydoc, this.trash);
      if (purged > 0) console.log(`[collab] purged ${purged} expired trash entries`);
    }

    console.log(
      `[collab] reconcile complete: manifest has ${this.map.size} entries, trash ${this.trash?.size ?? 0}`,
    );
  }

  private walk(folder: TFolder, out: TAbstractFile[]) {
    for (const child of folder.children) {
      out.push(child);
      if (child instanceof TFolder) this.walk(child, out);
    }
  }

  // Eager binary download with a parallelism cap. Status bar shows
  // progress as "syncing N/M binaries".
  private async downloadBinaries(
    items: Array<{ path: string; entry: ManifestEntry }>,
  ): Promise<void> {
    const client = this.deps.binaryClient();
    if (!client) {
      console.warn("[collab] downloadBinaries: no blob client");
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
          console.warn(`[collab] download ${path} failed`, err);
        }
        done++;
        this.deps.onDownloadProgress(
          done < total ? `syncing ${done}/${total} binaries` : null,
        );
      }
    };
    const workers = Math.min(MAX_PARALLEL_DOWNLOADS, items.length);
    await Promise.all(Array.from({ length: workers }, () => next()));
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
  ): Promise<void> {
    if (!entry.hash) {
      console.warn(`[collab] materialiseBinary ${path}: no hash on entry`);
      return;
    }
    this.deps.remoteApplyPaths.add(path);
    try {
      await this.ensureFolderExists(path);
      const existing = this.deps.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFolder) {
        console.warn(
          `[collab] materialiseBinary: ${path} is a local folder; manifest says binary — skipping`,
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
            return;
          }
        } catch (err) {
          console.warn(`[collab] materialiseBinary hash check failed for ${path}`, err);
        }
        // Local differs — overwrite with manifest bytes.
        const bytes = await client.download(entry.hash);
        const buf = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
        await this.deps.app.vault.modifyBinary(existing, buf);
        console.log(`[collab] materialise: binary ${path} updated (${bytes.byteLength}b)`);
        return;
      }
      const bytes = await client.download(entry.hash);
      const buf = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      try {
        await this.deps.app.vault.createBinary(path, buf);
        console.log(`[collab] materialise: binary ${path} (${bytes.byteLength}b)`);
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
      console.warn(
        `[collab] materialise: ${path} is a local folder; manifest says file — skipping create`,
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
          console.warn(
            `[collab] materialise: ${path} is a local file; manifest says folder — skipping`,
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
      console.warn(`[collab] materialise failed for ${path}`, err);
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
      console.log(`[collab] vault.create: already in manifest ${file.path}`);
      return;
    }
    console.log(`[collab] vault.create: ${file.path} (${kind})`);
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
      void this.deps.sessionManager.attach(file.path, sk, id);
    }
  }

  onLocalModify(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    if (file.extension === "md") return; // markdown content syncs via editor binding
    if (!this.map) return;
    if (this.deps.sessionManager.isReadOnly()) return;
    if (this.deps.remoteApplyPaths.has(file.path)) return;
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
    console.log(`[collab] vault.rename: ${oldPath} → ${file.path}`);
  }

  async onLocalDelete(file: TAbstractFile): Promise<void> {
    if (!this.map || !this.trash || !this.ydoc) return;
    if (this.deps.sessionManager.isReadOnly()) return;
    if (this.deps.remoteApplyPaths.has(file.path)) return;
    const entry = this.map.get(file.path);
    if (!entry) return;
    console.log(`[collab] vault.delete: ${file.path} (${entry.kind}, id=${entry.id})`);

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
      console.warn(`[collab] transientWipe failed for ${docId}`, err);
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
      console.warn(`[collab] uploadBinary: no blob client, skipping ${file.path}`);
      return;
    }
    try {
      const buf = await this.deps.app.vault.readBinary(file);
      const bytes = new Uint8Array(buf);
      if (buf.byteLength > LARGE_FILE_WARN_BYTES) {
        new Notice(
          `Collab: ${file.path} is ${Math.floor(buf.byteLength / 1024 / 1024)} MB — sync may take a while`,
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
      console.log(
        `[collab] uploadBinary: ${file.path} (${buf.byteLength}b, hash=${hash.slice(0, 12)}…)`,
      );
    } catch (err) {
      console.warn(`[collab] uploadBinary failed for ${file.path}`, err);
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
      console.log(
        `[collab] manifestChange: +${adds.length} ~${updates.length} -${deletes.length}`,
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
    // or a manifest entry was modified in place. Redownload binary.
    for (const u of updates) {
      if (u.entry.kind === "binary") {
        const client = this.deps.binaryClient();
        if (client) {
          // Force re-download by deleting local first then materialising.
          const local = this.deps.app.vault.getAbstractFileByPath(u.path);
          if (local instanceof TFile && u.entry.hash) {
            try {
              const cur = await this.deps.app.vault.readBinary(local);
              const curHash = await sha256Hex(new Uint8Array(cur));
              if (curHash === u.entry.hash) continue;
              const bytes = await client.download(u.entry.hash);
              const buf = bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              ) as ArrayBuffer;
              this.deps.remoteApplyPaths.add(u.path);
              try {
                await this.deps.app.vault.modifyBinary(local, buf);
              } finally {
                setTimeout(
                  () => this.deps.remoteApplyPaths.delete(u.path),
                  SUPPRESS_HOLD_MS,
                );
              }
            } catch (err) {
              console.warn(`[collab] update binary ${u.path} failed`, err);
            }
          } else if (!local) {
            await this.materialiseBinary(u.path, u.entry, client);
          }
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
      console.log(`[collab] remote rename: ${oldPath} → ${newPath}`);
    } catch (err) {
      console.warn("[collab] remote rename failed", oldPath, newPath, err);
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
      console.log(`[collab] remote delete: ${path}`);
    } catch (err) {
      console.warn("[collab] remote delete failed", path, err);
    } finally {
      setTimeout(
        () => this.deps.remoteApplyPaths.delete(path),
        SUPPRESS_HOLD_MS,
      );
    }
  }
}
