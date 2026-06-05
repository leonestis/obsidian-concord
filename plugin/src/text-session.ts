// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-file markdown session. Owns one Y.Doc + Y.Text + provider +
// IndexedDB persistence.
//
// In v2.0.0 this class knows NOTHING about CodeMirror or editor views.
// LiveViewManager (live-view-manager.ts) handles editor binding via the
// vendored yedit/ extensions, which resolve their Y.Text + Awareness
// dynamically from a Facet — there's no per-session "bound editor"
// state to track here. We just expose `ytext` and `provider.awareness`
// and trust the upstream wiring.
//
// The conflict-file path that v1.0.5 lived in (reconcileEditorAndYtext
// → save .conflict-<ISO>.md before letting the editor be overwritten)
// was removed in v2.0.0. Phase 3 replaces it (and the interim "ytext
// wins on divergence" trade-off) with a DiskBuffer-mediated three-way
// merge: yedit/y-sync.ts's reconcileBinding diffs the editor (THEIRS)
// against the Y.Text (OURS) using the DiskBuffer (BASE = last known
// consistent disk content, keyed by docId) and replays the local edits
// onto the CRDT so neither side's text is lost. This session's job in
// that scheme is to keep the BASE accurate: every successful disk-sync
// write (below) records the content it wrote as the new base.

import { App, TFile } from "obsidian";
import type { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";

import { Notice } from "obsidian";

import { log } from "./logger";
import { docIdToRoom, localBackupPath, onProviderSynced } from "./util";
import { DiskBuffer } from "./disk-buffer";
import { applyStringToYText, threeWayMerge } from "./yedit/y-sync";
import type { BaseSession, SessionOrigin } from "./types";

// Distinct transaction origin for background disk→Y.Text writes. Tagging
// the transaction lets the disk-sync observer and (when one later opens)
// the editor binding tell a background disk-merge apart from a genuine
// user edit. The editor binding skips transactions whose origin is the
// plugin instance (`tr.origin === this`); this origin is neither that
// nor a user keystroke, so it flows through to disk-sync (intended) and
// is never mistaken for a local edit to echo back upstream.
export const DISK_UPDATE_ORIGIN = "disk-update";

export interface TextSessionOptions {
  app: App;
  socket: HocuspocusProviderWebsocket;
  serverUrl: string;
  authToken: string | undefined;
  docId: string;
  path: string;
  // Invariant I3. "local" ONLY when we just created this file + its
  // manifest entry locally (brand-new server room). "remote" for any
  // peer-originated or pre-existing entry. Gates whether we may seed
  // local disk content into the shared ytext.
  origin: SessionOrigin;
  user: { name: string; color: string };
  remoteApplyPaths: {
    add: (p: string) => void;
    delete: (p: string) => void;
    has: (p: string) => boolean;
  };
  // v2.3.2 data-corruption fix. "Is this file currently OPEN in a live CM
  // editor anywhere in the workspace?" (LiveViewManager.hasEditorFor).
  // When a markdown file is open, Obsidian's OWN autosave persists the
  // editor to disk and the yedit binding keeps the editor == ytext — so
  // our ytext→disk write (disk-sync observer) and disk→ytext capture
  // (applyDiskUpdate) would only FIGHT Obsidian's writer and feed the
  // parity-thrash loop. Both are therefore SKIPPED while the file is open;
  // they run only for CLOSED files (e.g. a Kanban-rendered note).
  // Default-safe: if this callback is unavailable, treat the file as OPEN
  // (skip the plugin disk write — safer to let Obsidian own disk than to
  // fight it).
  isOpenInEditor?: (path: string) => boolean;
  debug: (...args: unknown[]) => void;
}

export class TextSession implements BaseSession {
  readonly sessionKind = "file" as const;
  readonly docId: string;
  path: string;
  // Invariant I3 — exposed so the editor binding (yedit) can gate
  // seed-from-editor on local origin too.
  readonly origin: SessionOrigin;

  readonly ydoc: Y.Doc;
  readonly ytext: Y.Text;
  readonly provider: HocuspocusProvider;
  readonly persistence: IndexeddbPersistence;

  private destroyed = false;
  private observers: Array<(e: Y.YTextEvent, t: Y.Transaction) => void> = [];
  private diskWriteTimer: ReturnType<typeof setTimeout> | null = null;

  // Invariant I2. True only after a GENUINE first `synced` with the
  // server (never a timeout). The editor binding (yedit) reads this via
  // syncedForReconcile() and refuses to seed/adopt/merge until it flips
  // true — and we re-poke open editors when it does so the bind reruns
  // with trustworthy ytext. Until then: do nothing destructive.
  private trulySynced = false;
  private syncUnsub: (() => void) | null = null;
  // Editors waiting for true sync register here; fired once on sync.
  private onSyncedListeners: Array<() => void> = [];
  // CRITICAL ordering guard. The disk-sync observer must NOT write
  // ytext→disk until the bind/connect reconcile (reconcileOnTrueSync)
  // has run and decided what to do — otherwise, when the server's
  // content streams into ytext on sync, the observer would write it over
  // a non-empty LOCAL file (walkthrough 2's "My notes") BEFORE reconcile
  // gets a chance to back that local content up. Stays false until
  // reconcileOnTrueSync completes (it sets it true just before any
  // ytext→disk write it performs itself).
  private reconcileDone = false;
  // Shared BASE store for the Phase 3 three-way merge. Every time the
  // disk-sync writer confirms disk == ytext (whether it just wrote it or
  // disk already matched), that content is the new "last known
  // consistent" snapshot — so we record it here as the merge base.
  private readonly diskBuffer = DiskBuffer.shared();

  private constructor(private readonly opts: TextSessionOptions) {
    this.docId = opts.docId;
    this.path = opts.path;
    this.origin = opts.origin;

    this.ydoc = new Y.Doc();
    this.ytext = this.ydoc.getText("content");

    const room = docIdToRoom(this.docId);
    this.provider = new HocuspocusProvider({
      websocketProvider: opts.socket,
      name: room,
      document: this.ydoc,
      token: opts.authToken || undefined,
    });
    // CRITICAL: shared websocketProvider mode requires explicit attach.
    this.provider.attach();

    this.provider.on("status", (e: { status: string }) => {
      opts.debug(`[collab] room ${room} (${this.path}) status: ${e.status}`);
    });
    this.provider.on("authenticationFailed", (d: { reason: string }) => {
      log.error("session", `room ${room} auth failed: ${d.reason}`);
    });

    // NOTE (v2.0.0): we no longer seed `user` here. LocalPresenceController
    // owns every awareness state write — it iterates bound markdown
    // sessions and broadcasts `{ user, cursor: null }` whenever a new
    // session enters the bound state (triggered by sessionReady). The
    // motivation is in local-presence.ts's header; the short version
    // is "scattered awareness writes were the source of every 'peer
    // invisible' bug from v0.9.x onward".

    this.persistence = new IndexeddbPersistence(
      `obsidian-collab::${opts.serverUrl}::${room}`,
      this.ydoc,
    );
  }

  // Async factory: create + wait for first sync. The seed-from-disk
  // step that used to live here moved to
  // SessionManager.bindOne → TextSession.reconcileEditorAndYtext
  // (v1.0.5). Reasons for the move:
  //   1. The disk-read happened during the 4-second `await sync` window.
  //      Any keystroke the user typed in the (already-open) editor
  //      during that window did NOT reach disk yet (Obsidian's auto-save
  //      is async), so disk content lagged the editor. Seeding ytext
  //      from disk meant reconcile would later see editor != ytext
  //      and route the user's typing to a `.conflict-*` file — a
  //      false positive.
  //   2. The disk-seed branch had the opposite hazard too: if ytext
  //      had a few merged chars from IndexedDB on reconnect but disk
  //      had MORE chars (offline edit via another tool), the create()
  //      branch did nothing (ytext.length > 0 → skip seed), then the
  //      binding's parity check would replace the editor with the
  //      shorter ytext content. That's exactly the Bug-3 data-loss
  //      class the user is at the end of their rope about.
  //   3. reconcileEditorAndYtext at bindOne time has access to the
  //      EditorView. It can compare editor.toString() (the actual
  //      user-visible content, including unsaved keystrokes) to
  //      ytext.toString() (the synced CRDT state) and pick the right
  //      action per case. That's where the seed should live.
  //
  // For markdown the only attach() call sites that lead to a bound
  // session — handleMarkdownFileOpen and ManifestSync.onLocalCreate's
  // .then — both call bindEditorIfReady right after, which calls
  // reconcile. So the seed path is exercised on every markdown attach
  // that has an editor open.
  //
  // If a markdown attach is ever introduced that has NO editor (e.g.
  // a future "background sync this file" feature), it must reconcile
  // against disk itself before installing the disk-sync observer.
  static async create(opts: TextSessionOptions): Promise<TextSession> {
    const s = new TextSession(opts);
    // Let IndexedDB hydrate the local CRDT cache before we wire the
    // synced handler, so that on a TRUE sync the merge sees the full
    // local-cache state. We bound the wait so a cold IndexedDB never
    // blocks attach indefinitely; if it loses the race the synced
    // handler still re-reads live ytext, so correctness holds.
    await Promise.race([
      s.persistence.whenSynced,
      new Promise<void>((r) => setTimeout(r, 4000)),
    ]);
    if (s.destroyed) return s;

    // INVARIANT I2 — event-driven reconcile on TRUE sync only.
    //
    // We do NOT seed/merge here on a timed race. The reconcile runs
    // ONLY when the provider genuinely syncs (server delivered its
    // state). onProviderSynced fires:
    //   - immediately (next microtask) if already synced, or
    //   - on the first real `synced` event (provider keeps retrying in
    //     the background after any timeout).
    // Until then the disk-sync observer is installed (so genuine LIVE
    // ytext changes still flow to disk) but reconcileOnTrueSync has not
    // run, so we never blind-seed or blind-adopt against a not-yet-
    // delivered server doc.
    //
    // installDiskSync is safe to install before sync because its
    // observer only writes ytext→disk when they DIFFER, and on a brand-
    // new (not-yet-synced) room ytext is whatever IndexedDB hydrated —
    // it does not push disk INTO ytext. The dangerous direction
    // (disk→ytext seed) happens ONLY inside reconcileOnTrueSync, gated
    // on true sync + origin.
    s.installDiskSync();
    s.syncUnsub = onProviderSynced(s.provider, () => {
      if (s.destroyed) return;
      void s.reconcileOnTrueSync();
    });
    return s;
  }

  // True iff the provider has genuinely synced (I2). The editor binding
  // (yedit) reads this before doing anything destructive on bind.
  syncedForReconcile(): boolean {
    return this.trulySynced;
  }

  // Editors register here to be re-poked once true sync lands, so their
  // reconcileBinding reruns with trustworthy ytext. Returns an
  // unsubscribe. If already synced, fires on the next microtask.
  onTrueSync(cb: () => void): () => void {
    if (this.trulySynced) {
      queueMicrotask(() => {
        if (!this.destroyed) cb();
      });
      return () => {};
    }
    this.onSyncedListeners.push(cb);
    return () => {
      const i = this.onSyncedListeners.indexOf(cb);
      if (i >= 0) this.onSyncedListeners.splice(i, 1);
    };
  }

  // ── INVARIANT-COMPLIANT bind/connect decision tree (I1–I4, I6) ──────
  //
  // Runs exactly once, on the FIRST genuine server sync. At this point
  // ytext.toString() is authoritative as "what the server has". For the
  // background (non-editor) session, "local content" = disk content.
  // (The editor binding runs its OWN identical tree via yedit, gated on
  // syncedForReconcile() + a file-identity check.)
  //
  //   1. origin==="local" AND ytext empty: OUR brand-new file. Seed
  //      ytext from disk. DiskBuffer = disk. (The ONLY seed-from-local.)
  //   2. else (peer-originated OR ytext already has content):
  //      a. base = DiskBuffer.get(docId).
  //      b. base exists  → real 3-way merge (legit offline-edit case).
  //      c. base is null →
  //           - disk === ytext      : in sync, DiskBuffer = disk.
  //           - disk empty          : adopt ytext, DiskBuffer = ytext.
  //           - disk non-empty,
  //             differs from ytext  : SERVER WINS. Back up disk to
  //                                   <path>.local-backup-<docId>.md,
  //                                   Notice, then adopt ytext.
  //                                   NEVER additively merge.
  private async reconcileOnTrueSync(): Promise<void> {
    if (this.destroyed) return;
    // Mark synced + wake any waiting editors regardless of how the disk
    // reconcile below resolves — the editor path does its own reconcile.
    this.trulySynced = true;
    const waiters = this.onSyncedListeners.splice(0);
    for (const cb of waiters) {
      try {
        cb();
      } catch (err) {
        log.warn("session", `onTrueSync listener threw for ${this.path}`, err);
      }
    }

    try {
      await this.runReconcileDecision();
    } finally {
      // The decision is made (or failed). From now on the disk-sync
      // observer is allowed to write ytext→disk. We also do one explicit
      // ytext→disk flush: any ytext change that arrived while
      // reconcileDone was still false was DROPPED by the observer, and a
      // branch like "disk empty → adopt" or "3-way merge" expects ytext
      // to land on disk. writeYtextToDisk is a no-op when disk already
      // matches, so this is safe for the in-sync / seeded branches too.
      // NOTE: if the SERVER-WINS branch failed to back up, it left
      // reconcileDone false-equivalent by NOT adopting — but we still
      // must NOT clobber: that branch leaves disk as the user's local
      // content and ytext as server content, and we WANT the local file
      // preserved. To honour that, the backup-failure branch sets a flag
      // (backupFailed) that suppresses this flush.
      this.reconcileDone = true;
      if (!this.suppressDiskFlush) {
        await this.writeYtextToDisk();
      }
    }
  }

  // True only when the SERVER-WINS branch could NOT back up the local
  // content. In that single case we must NOT flush ytext→disk (that
  // would destroy the un-backed-up local file). Everything stays as-is
  // until the next true sync retries.
  private suppressDiskFlush = false;

  private async runReconcileDecision(): Promise<void> {
    if (this.destroyed) return;
    const tfile = this.opts.app.vault.getAbstractFileByPath(this.path);
    if (!(tfile instanceof TFile)) return;
    let disk: string;
    let ytextStr: string;
    try {
      disk = await this.opts.app.vault.read(tfile);
      ytextStr = this.ytext.toString();
    } catch (err) {
      log.warn("session", `reconcileOnTrueSync read failed for ${this.path}`, err);
      return;
    }
    if (this.destroyed) return;

    // Step 1 — OUR brand-new file, empty server room. Seed from disk.
    // This is the ONLY place background seed-from-local is allowed (I3).
    if (this.opts.origin === "local" && this.ytext.length === 0) {
      if (disk.length > 0) {
        applyStringToYText(this.ytext, disk, DISK_UPDATE_ORIGIN);
      }
      void this.diskBuffer.set(this.docId, disk);
      log.info(
        "session",
        `reconcile ${this.path}: seeded brand-new (local origin) ytext from disk (${disk.length})`,
      );
      return;
    }

    // Step 2 — peer-originated, or ytext already has content.
    if (disk === ytextStr) {
      // In sync. Record base.
      void this.diskBuffer.set(this.docId, disk);
      return;
    }

    let base: string | null = null;
    try {
      base = (await this.diskBuffer.get(this.docId)) ?? null;
    } catch {
      /* treat as missing base */
    }
    if (this.destroyed) return;
    // Re-read live ytext: remote ops may have landed during the await.
    const liveYtext = this.ytext.toString();
    if (disk === liveYtext) {
      void this.diskBuffer.set(this.docId, liveYtext);
      return;
    }

    // 2b — base exists: legit offline-edit case. Real 3-way merge so
    // both the offline-local disk edits and remote edits survive.
    if (base != null) {
      const merged = threeWayMerge(base, liveYtext, disk);
      applyStringToYText(this.ytext, merged, DISK_UPDATE_ORIGIN);
      void this.diskBuffer.set(this.docId, merged);
      log.info(
        "session",
        `reconcile ${this.path}: 3-way merge (base=${base.length}, ytext=${liveYtext.length}, disk=${disk.length} → ${merged.length})`,
      );
      return;
    }

    // 2c — NO base. We have never synced this file before, so we cannot
    // tell offline-edits from "this is a different file's content". A
    // merge here is exactly the Bug-1 corruption source. So:
    if (disk.length === 0) {
      // Nothing local to lose — adopt ytext. The disk-sync observer
      // writes ytext→disk; record ytext as base.
      void this.diskBuffer.set(this.docId, liveYtext);
      log.info(
        "session",
        `reconcile ${this.path}: no base, disk empty → adopt ytext (${liveYtext.length})`,
      );
      return;
    }
    // disk non-empty AND differs from ytext, no base → SERVER WINS.
    // Back up the local disk content (so it's never lost), then adopt
    // ytext. NEVER additively merge into the shared doc.
    await this.backupLocalThenAdopt(disk, liveYtext);
  }

  // SERVER WINS path (I4). Save the local disk content to a local-only
  // backup sibling, Notice the user. We do NOT write the live file here:
  // the unified ytext→disk flush in reconcileOnTrueSync's finally adopts
  // ytext onto disk (and records the base) once reconcileDone flips. If
  // the backup FAILS we set suppressDiskFlush so that flush is skipped —
  // the live file keeps the un-backed-up local content, ytext stays the
  // server version, and the next true sync retries. Never clobber
  // un-backed-up data. The backup file is suppressed via remoteApplyPaths
  // and skipped by classify(), so it never enters the manifest / peers.
  private async backupLocalThenAdopt(
    diskContent: string,
    ytextStr: string,
  ): Promise<void> {
    const ok = await this.backupLocalContent(diskContent);
    if (!ok) {
      this.suppressDiskFlush = true;
      return;
    }
    // Backup is safe — record ytext as the new base; the finally-flush
    // writes ytext onto disk so the user sees the shared version.
    void this.diskBuffer.set(this.docId, ytextStr);
  }

  // SERVER-WINS backup (I4), reusable by both the background reconcile
  // and the editor binding (yedit). Persists `content` to a LOCAL-ONLY
  // backup sibling `<path>.local-backup-<docId>.md`, Notices the user.
  // Returns true on success (caller may safely adopt ytext), false on
  // failure (caller must NOT adopt — local content wasn't preserved).
  //
  // Loop/echo safety: the create/modify is wrapped in remoteApplyPaths
  // so onLocalCreate/onLocalModify drop it, and classify() skips
  // `.local-backup-*` so the backup NEVER enters the manifest or syncs
  // to peers regardless. It exists purely on this device for recovery.
  async backupLocalContent(content: string): Promise<boolean> {
    if (this.destroyed) return false;
    const backupPath = localBackupPath(this.path, this.docId);
    try {
      const existing = this.opts.app.vault.getAbstractFileByPath(backupPath);
      this.opts.remoteApplyPaths.add(backupPath);
      try {
        if (existing instanceof TFile) {
          // Reuse the stable per-docId backup name (overwrite) instead of
          // spawning duplicates on repeated reconciles.
          await this.opts.app.vault.modify(existing, content);
        } else if (!existing) {
          await this.opts.app.vault.create(backupPath, content);
        } else {
          // A folder sits at that path (pathological). Bail as failure.
          return false;
        }
      } finally {
        setTimeout(() => this.opts.remoteApplyPaths.delete(backupPath), 1000);
      }
      log.info(
        "session",
        `${this.path}: server wins — backed up local content (${content.length}) to ${backupPath}`,
      );
      try {
        new Notice(
          `Collab: ${this.path} had local changes that differ from the shared version. ` +
            `The shared version was kept; your local copy is saved as ${backupPath}.`,
          12_000,
        );
      } catch {
        /* Notice unavailable in some contexts; ignore */
      }
      return true;
    } catch (err) {
      log.warn(
        "session",
        `${this.path}: local-backup failed; NOT adopting (local content left intact)`,
        err,
      );
      return false;
    }
  }

  // One-shot ytext→disk writer (mirrors the disk-sync observer body)
  // used by the SERVER-WINS adopt so the live file converges immediately
  // instead of waiting for the next ytext change.
  private async writeYtextToDisk(): Promise<void> {
    if (this.destroyed) return;
    const tfile = this.opts.app.vault.getAbstractFileByPath(this.path);
    if (!(tfile instanceof TFile)) return;
    let content: string;
    try {
      content = this.ytext.toString();
    } catch {
      return;
    }
    try {
      const current = await this.opts.app.vault.read(tfile);
      if (this.destroyed) return;
      if (current === content) {
        void this.diskBuffer.set(this.docId, content);
        return;
      }
      this.opts.remoteApplyPaths.add(this.path);
      await this.opts.app.vault.modify(tfile, content);
      void this.diskBuffer.set(this.docId, content);
    } catch (err) {
      log.warn("session", `writeYtextToDisk failed for ${this.path}`, err);
    } finally {
      setTimeout(() => this.opts.remoteApplyPaths.delete(this.path), 1000);
    }
  }

  // v2.3.2: true when this file is OPEN in a live CM editor anywhere.
  // Default-safe — absent callback ⇒ treat as OPEN (skip plugin disk
  // writes; let Obsidian's autosave own disk). See TextSessionOptions.
  private isOpenInEditor(): boolean {
    const cb = this.opts.isOpenInEditor;
    if (!cb) return true;
    try {
      return cb(this.path);
    } catch {
      return true;
    }
  }

  private installDiskSync() {
    const observer = () => {
      if (this.destroyed) return;
      // Ordering guard (see reconcileDone): do NOT write ytext→disk
      // before the bind/connect reconcile has run. When the server's
      // content first streams into ytext on sync, this observer fires —
      // but if reconcile hasn't decided yet, writing here would clobber a
      // non-empty local file before reconcile can back it up. We drop
      // (don't reschedule) — reconcileOnTrueSync performs the correct
      // ytext→disk write itself once it has backed up / decided, and any
      // post-reconcile ytext change re-fires this observer normally.
      if (!this.reconcileDone) return;
      if (this.diskWriteTimer) clearTimeout(this.diskWriteTimer);
      this.diskWriteTimer = setTimeout(async () => {
        this.diskWriteTimer = null;
        if (this.destroyed) return;
        // v2.3.2 CORE FIX — exactly ONE owner of disk↔ytext per file.
        // If the file is OPEN in a CM editor, Obsidian's own autosave
        // already writes the editor (which yedit keeps == ytext) to disk.
        // Our write here would only fight Obsidian's editor→disk autosave
        // and feed the parity-thrash / doubling loop. So SKIP for open
        // files; we own ytext→disk only for CLOSED files (so a remote
        // peer's edit to a file you don't have open still lands on disk
        // for e.g. Kanban to read). Re-checked at write time (not just at
        // observe time) because the file may have just been opened.
        if (this.isOpenInEditor()) return;
        const tfile = this.opts.app.vault.getAbstractFileByPath(this.path);
        if (!(tfile instanceof TFile)) return;
        let content: string;
        try {
          content = this.ytext.toString();
        } catch (err) {
          log.warn("binding", `disk-sync read failed for ${this.path}`, err);
          return;
        }
        try {
          const current = await this.opts.app.vault.read(tfile);
          if (this.destroyed) return;
          if (current === content) {
            // Disk already matches ytext — they're consistent. This IS a
            // valid merge base; record it so a later offline divergence
            // has an accurate ancestor to diff against.
            void this.diskBuffer.set(this.docId, content);
            return;
          }
          this.opts.remoteApplyPaths.add(this.path);
          await this.opts.app.vault.modify(tfile, content);
          // The content we just wrote to disk is now the known-consistent
          // snapshot (disk == ytext). Update the merge base.
          void this.diskBuffer.set(this.docId, content);
          this.opts.debug(
            `[collab] disk-sync ${this.path}: wrote ${content.length} chars`,
          );
        } catch (err) {
          log.warn("binding", `disk-sync failed for ${this.path}`, err);
        } finally {
          // Suppression hold matches the legacy SUPPRESS_HOLD_MS (1 s) —
          // long enough for Obsidian's modify event to fire and be
          // dropped by onLocalVaultModify.
          setTimeout(() => this.opts.remoteApplyPaths.delete(this.path), 1000);
        }
      }, 300);
    };
    this.ytext.observe(observer);
    this.observers.push(observer);
  }

  // Background (non-editor) disk→Y.Text capture. Called by
  // ManifestSync.onLocalModify when ANOTHER plugin (e.g. Kanban) writes
  // this markdown file to disk while it is NOT open in a CodeMirror
  // editor. The open-editor path is owned entirely by the yedit binding
  // (y-sync.ts) and must never reach here — manifest-sync guards on
  // hasEditorFor() before calling us.
  //
  // We diff ytext→disk and apply the minimal insert/delete ops onto
  // ytext (NOT a blind delete-all+insert), so any remote edits that
  // landed in ytext between the disk read and this apply are preserved
  // by diff-match-patch's offset-relative ops. The transaction carries
  // DISK_UPDATE_ORIGIN so it isn't mistaken for a user edit.
  //
  // Loop safety: this method writes to ytext only. The disk-sync
  // observer will then fire, read ytext (now equal to what we just
  // diffed FROM disk) and short-circuit on `current === content` — it
  // will NOT re-write disk, so there's no echo. This method does not
  // write disk itself, so it needs no remoteApplyPaths suppression.
  async applyDiskUpdate(): Promise<void> {
    if (this.destroyed) return;
    // I2: do not push disk→ytext before the bind/connect reconcile has
    // run on a true sync. Before that, ytext is not trustworthy and
    // forwarding disk content could push local content into a not-yet-
    // delivered shared doc (I1). The reconcile itself handles the
    // pre-sync disk content; a genuine post-sync external modify reaches
    // here normally.
    if (!this.reconcileDone) return;
    // v2.3.2 CORE FIX — disk→ytext capture must NOT run for OPEN files.
    // For an open file the yedit binding is the SOLE editor↔ytext link
    // and Obsidian's autosave owns editor→disk; reading disk back into
    // ytext here would feed the feedback loop (writer #4 in the bug
    // report). manifest-sync.onLocalModify already guards via
    // hasEditorFor, but this is the robust belt-and-suspenders check at
    // the actual mutation site. Default-safe (absent callback ⇒ OPEN ⇒
    // skip). Capture runs only for CLOSED files (Kanban writing the .md).
    if (this.isOpenInEditor()) return;
    const tfile = this.opts.app.vault.getAbstractFileByPath(this.path);
    if (!(tfile instanceof TFile)) return;
    let diskContent: string;
    try {
      diskContent = await this.opts.app.vault.read(tfile);
    } catch (err) {
      log.warn("binding", `applyDiskUpdate read failed for ${this.path}`, err);
      return;
    }
    if (this.destroyed) return;
    let current: string;
    try {
      current = this.ytext.toString();
    } catch (err) {
      log.warn("binding", `applyDiskUpdate ytext read failed for ${this.path}`, err);
      return;
    }
    if (diskContent === current) return; // already consistent — no-op
    const changed = applyStringToYText(this.ytext, diskContent, DISK_UPDATE_ORIGIN);
    if (changed) {
      // Disk and ytext now agree; record the merge base so a later
      // offline divergence has an accurate ancestor.
      void this.diskBuffer.set(this.docId, diskContent);
      this.opts.debug(
        `[collab] applyDiskUpdate ${this.path}: merged disk → ytext (${diskContent.length} chars)`,
      );
    }
  }

  // v1.0.5's reconcileEditorAndYtext is GONE in v2.0.0. The reconcile
  // now lives in yedit/y-sync.ts's reconcileBinding (cases 1–4): seed,
  // adopt, in-sync, or — when editor and ytext both have content and
  // differ — a DiskBuffer-mediated three-way merge that preserves BOTH
  // the local offline edits and the remote edits. The .conflict-*.md
  // generation stays dropped; the merge replaces it without the
  // false-positive files v1.x created under view recycling.

  wipe(): void {
    if (this.destroyed) return;
    try {
      this.ydoc.transact(() => {
        if (this.ytext.length > 0) this.ytext.delete(0, this.ytext.length);
      });
      log.info("session", `TextSession.wipe: cleared Y.Text for ${this.path}`);
    } catch (err) {
      log.warn("session", `TextSession.wipe failed for ${this.path}`, err);
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.diskWriteTimer) {
      clearTimeout(this.diskWriteTimer);
      this.diskWriteTimer = null;
    }
    if (this.syncUnsub) {
      try {
        this.syncUnsub();
      } catch {
        /* ignore */
      }
      this.syncUnsub = null;
    }
    this.onSyncedListeners.length = 0;
    for (const fn of this.observers) {
      try {
        this.ytext.unobserve(fn);
      } catch {
        /* ignore */
      }
    }
    this.observers.length = 0;
    try {
      await this.persistence.destroy();
    } catch (err) {
      log.warn("session", `TextSession persistence destroy failed`, err);
    }
    try {
      if (this.provider.awareness) {
        this.provider.awareness.setLocalState(null);
        removeAwarenessStates(
          this.provider.awareness,
          [this.provider.awareness.clientID],
          "destroy",
        );
      }
    } catch {
      /* ignore */
    }
    this.provider.destroy();
    this.ydoc.destroy();
    log.info("session", `TextSession.destroy: ${this.path}`);
  }
}
