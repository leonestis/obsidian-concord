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

import { log } from "./logger";
import { docIdToRoom, waitForProviderSync } from "./util";
import { DiskBuffer } from "./disk-buffer";
import {
  applyStringToYText,
  threeWayMerge,
  additiveMerge,
} from "./yedit/y-sync";
import type { BaseSession } from "./types";

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
  user: { name: string; color: string };
  remoteApplyPaths: {
    add: (p: string) => void;
    delete: (p: string) => void;
    has: (p: string) => boolean;
  };
  debug: (...args: unknown[]) => void;
}

export class TextSession implements BaseSession {
  readonly sessionKind = "file" as const;
  readonly docId: string;
  path: string;

  readonly ydoc: Y.Doc;
  readonly ytext: Y.Text;
  readonly provider: HocuspocusProvider;
  readonly persistence: IndexeddbPersistence;

  private destroyed = false;
  private observers: Array<(e: Y.YTextEvent, t: Y.Transaction) => void> = [];
  private diskWriteTimer: ReturnType<typeof setTimeout> | null = null;
  // Shared BASE store for the Phase 3 three-way merge. Every time the
  // disk-sync writer confirms disk == ytext (whether it just wrote it or
  // disk already matched), that content is the new "last known
  // consistent" snapshot — so we record it here as the merge base.
  private readonly diskBuffer = DiskBuffer.shared();

  private constructor(private readonly opts: TextSessionOptions) {
    this.docId = opts.docId;
    this.path = opts.path;

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
    await Promise.race([
      Promise.all([
        s.persistence.whenSynced,
        waitForProviderSync(s.provider, 4000),
      ]),
      new Promise<void>((r) => setTimeout(r, 4000)),
    ]);
    // BACKGROUND-SAFE SEED. With eager whole-vault attach (v2.1.x), a
    // markdown session is now created even when the file is NOT open in
    // an editor — so the editor's reconcileBinding (yedit/y-sync.ts) is
    // NOT guaranteed to run and seed/merge ytext against disk. If we
    // installed disk-sync straight away, the very next ytext change
    // (or an empty just-synced room) could blind-write an EMPTY ytext
    // over a non-empty local file — exactly the data-loss class this
    // project keeps regressing on.
    //
    // So before installing disk-sync we reconcile ytext against the
    // current disk content using the SAME loss-free primitives the
    // editor path uses (threeWayMerge / additiveMerge / diff-apply).
    // This is the "reconcile against disk itself" the create() header
    // has warned about since v2.0.0.
    //
    // If an editor is already open on this file when create() runs, the
    // editor's reconcileBinding will run too (on its next update/wake)
    // and converge editor↔ytext; our disk-based seed here is consistent
    // with disk, and disk lags the editor by at most Obsidian's async
    // autosave — so the two reconcilers agree on steady state. We still
    // do the disk seed unconditionally because it is loss-free in every
    // case (it never deletes content without a BASE ancestor).
    await s.seedFromDisk();
    s.installDiskSync();
    return s;
  }

  // Loss-free initial reconcile of ytext against disk, run once before
  // installDiskSync for background (and editor) markdown sessions.
  // Mirrors reconcileBinding's case taxonomy with disk as THEIRS:
  //   1. equal            → record base, no-op
  //   2. ytext empty      → seed ytext from disk (insert)
  //   3. disk empty       → adopt ytext (nothing on disk to lose); the
  //                         disk-sync observer will write ytext→disk
  //   4. both differ      → BASE-mediated 3-way merge (or additive
  //                         fallback when no BASE) so neither side is lost
  // All ytext writes use DISK_UPDATE_ORIGIN.
  private async seedFromDisk(): Promise<void> {
    if (this.destroyed) return;
    const tfile = this.opts.app.vault.getAbstractFileByPath(this.path);
    if (!(tfile instanceof TFile)) return;
    let disk: string;
    let current: string;
    try {
      disk = await this.opts.app.vault.read(tfile);
      current = this.ytext.toString();
    } catch (err) {
      log.warn("session", `seedFromDisk read failed for ${this.path}`, err);
      return;
    }
    if (this.destroyed) return;

    // Case 1 — already consistent.
    if (disk === current) {
      void this.diskBuffer.set(this.docId, disk);
      return;
    }
    // Case 2 — ytext empty, disk has content: seed.
    // Case 3 — disk empty, ytext has content: nothing on disk to lose.
    //          The disk-sync observer (installed right after) writes
    //          ytext→disk on its first fire, so we leave ytext as-is and
    //          just record ytext as the base.
    if (current.length === 0 && disk.length > 0) {
      applyStringToYText(this.ytext, disk, DISK_UPDATE_ORIGIN);
      void this.diskBuffer.set(this.docId, disk);
      return;
    }
    if (disk.length === 0 && current.length > 0) {
      void this.diskBuffer.set(this.docId, current);
      return;
    }
    // Case 4 — both non-empty AND differ. BASE-mediated 3-way merge so
    // neither offline-local disk edits nor synced remote edits are lost.
    let base: string | null = null;
    try {
      base = (await this.diskBuffer.get(this.docId)) ?? null;
    } catch {
      /* treat as missing base */
    }
    if (this.destroyed) return;
    // Re-read live ytext in case remote ops landed during the await.
    const liveYtext = this.ytext.toString();
    if (liveYtext === disk) {
      void this.diskBuffer.set(this.docId, disk);
      return;
    }
    const merged =
      base != null
        ? threeWayMerge(base, liveYtext, disk)
        : additiveMerge(liveYtext, disk);
    applyStringToYText(this.ytext, merged, DISK_UPDATE_ORIGIN);
    void this.diskBuffer.set(this.docId, merged);
    log.info(
      "session",
      `seedFromDisk ${this.path}: ${base != null ? "3-way" : "additive"} merge (disk=${disk.length}, ytext=${liveYtext.length} → ${merged.length})`,
    );
  }

  private installDiskSync() {
    const observer = () => {
      if (this.destroyed) return;
      if (this.diskWriteTimer) clearTimeout(this.diskWriteTimer);
      this.diskWriteTimer = setTimeout(async () => {
        this.diskWriteTimer = null;
        if (this.destroyed) return;
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
