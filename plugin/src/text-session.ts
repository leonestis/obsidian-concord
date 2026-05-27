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
// was removed in v2.0.0. The replacement: yedit/y-sync.ts seeds an
// empty ytext from the editor when binding to a fresh-zero session
// (the "first peer" case), and on a TRUE ytext-vs-editor divergence it
// runs a minimal diff-based push from ytext to editor (so caret + undo
// state survive). Phase 3 will add disk-mediated 3-way merge; until
// then we explicitly accept the v0.9.2 "ytext wins on divergence"
// trade-off rather than the v1.0.5 false-positive .conflict files.

import { App, TFile } from "obsidian";
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

  // v1.0.5's reconcileEditorAndYtext is GONE in v2.0.0. The "seed
  // ytext from editor when ytext is empty" branch moved into
  // yedit/y-sync.ts's rebind path (case b in that file). The
  // .conflict-*.md generation is dropped on purpose — it was a
  // false-positive factory under view recycling (the editor briefly
  // held disk content while ytext arrived with the synced state, and
  // the diff was misread as user-vs-server conflict). Phase 3 will
  // bring back conflict detection backed by a real disk buffer +
  // 3-way merge.

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
