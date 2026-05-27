// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-file markdown session. Owns one Y.Doc + Y.Text + provider +
// IndexedDB persistence. The editor binding is created lazily by
// SessionManager when an EditorView becomes available for this path —
// we expose `ytext` and `provider.awareness` for that wiring, and
// otherwise know nothing about CodeMirror.

import { App, Notice, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import type { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";

import { log } from "./logger";
import { docIdToRoom, waitForProviderSync } from "./util";
import type { BaseSession } from "./types";

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

    this.provider.awareness?.setLocalStateField("user", opts.user);

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
    s.installDiskSync();
    return s;
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
          if (current === content) return;
          this.opts.remoteApplyPaths.add(this.path);
          await this.opts.app.vault.modify(tfile, content);
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

  // v1.0.5 Bug 3 — called by SessionManager.bindOne BEFORE the editor
  // compartment is reconfigured with the collab-binding. Reconciles the
  // editor's current document content against this session's ytext
  // content WITHOUT relying on the parity check (which is destructive
  // — it always replaces editor content with ytext content). The cases:
  //
  //   1. editor === ytext  → no-op. The common path.
  //   2. ytext is empty, editor has content → seed ytext from editor.
  //      This is the "first peer on this file" path; without this,
  //      the parity check would do nothing (editor.length === 0 and
  //      ytext.length === 0 would never differ once binding installs)
  //      and the user's content would never reach peers. Note: the
  //      seed-from-disk hook in `create()` already covers the case
  //      where the editor is closed and disk is the source; this
  //      branch covers the case where Obsidian opened the file (so
  //      its editor has the disk content) BEFORE we connected, and
  //      ytext was created fresh.
  //   3. editor is empty, ytext has content → no-op here; the binding's
  //      parity check on the first update cycle will dispatch the
  //      ytext content into the editor, which is the correct direction.
  //   4. both differ, both non-empty → TRUE CONFLICT. ytext was synced
  //      to some earlier state, then the user edited the disk file
  //      offline / with the plugin disabled / via another tool, and
  //      now we're reconnecting. The legacy code path silently replaced
  //      the editor with ytext, destroying the user's offline edits.
  //      v1.0.5 saves the editor's content to a sibling
  //      `<path>.conflict-<ISO timestamp>.md` BEFORE letting the parity
  //      check replace the editor. The conflict file goes through the
  //      normal manifest-sync path (it's a fresh `vault.create`), so
  //      peers also receive a copy of the unsynced edits.
  //
  // Reentrancy: this is called from bindOne in the SessionManager. The
  // method awaits vault.create / Notice / log calls, so the bindOne
  // caller path is async. Concurrent calls (two bindOne for the same
  // session in different views) interleave through the awaits; both
  // can run safely — the seed-into-ytext insert is conditional on
  // ytext.length === 0, and the conflict-file path uses a unique
  // timestamp per call so two simultaneous saves get distinct paths.
  async reconcileEditorAndYtext(
    view: EditorView,
    path: string,
  ): Promise<void> {
    if (this.destroyed) return;
    const editorContent = view.state.doc.toString();
    const ytextContent = this.ytext.toString();
    if (editorContent === ytextContent) return;

    if (this.ytext.length === 0) {
      // First peer on this file — push editor content into ytext.
      // Single-insert transaction; the disk-sync observer will fire,
      // but at this point editor === post-insert ytext so no echo loop.
      try {
        this.ytext.insert(0, editorContent);
        log.info(
          "binding",
          `reconcile seed ytext from editor: ${path} (${editorContent.length} chars)`,
        );
      } catch (err) {
        log.warn("binding", `reconcile seed failed for ${path}`, err);
      }
      return;
    }

    if (editorContent.length === 0) {
      // Editor empty, ytext non-empty. The collab-binding's parity
      // check will dispatch the ytext content into the editor on the
      // first update. Nothing to do here.
      return;
    }

    // True conflict: save editor's version as a sibling .conflict file
    // BEFORE the parity check replaces the editor. The conflict file is
    // a real vault file, so manifest-sync will propagate it to peers
    // (they get a copy of the unsynced edits and can compare). It's
    // also a markdown file (.md extension preserved via the dotted
    // suffix), so all normal markdown handling still applies — but
    // because it has a brand-new path, manifest-sync will mint a fresh
    // UUID for it and the collab room is separate; no chance of
    // re-conflicting with the original.
    const tsIso = new Date().toISOString().replace(/[:.]/g, "-");
    const conflictPath = `${path}.conflict-${tsIso}.md`;
    try {
      await this.opts.app.vault.create(conflictPath, editorContent);
      new Notice(
        `Collab: unsynced local edits on "${path}" saved to "${conflictPath}". Server version loaded.`,
        8000,
      );
      log.warn(
        "binding",
        `reconcile conflict: saved ${path}'s editor content (${editorContent.length} chars, ytext was ${ytextContent.length}) to ${conflictPath}`,
      );
    } catch (err) {
      log.error(
        "binding",
        `reconcile conflict: failed to save conflict file for ${path}`,
        err,
      );
      new Notice(
        `Collab: COULD NOT save local edits for "${path}" before overwriting. Check the console — your version is still in this editor for one update cycle, copy it now.`,
        12_000,
      );
    }
    // Don't touch the editor here. The compartment.reconfigure that
    // follows in bindOne installs the collab-binding; its first update
    // cycle's parity check sees editor.length !== ytext.length and
    // schedules a setTimeout(0) full-document replace with ytext's
    // content. That replace IS the "load server version" step the
    // Notice promised the user.
  }

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
