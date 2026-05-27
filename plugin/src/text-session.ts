// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-file markdown session. Owns one Y.Doc + Y.Text + provider +
// IndexedDB persistence. The editor binding is created lazily by
// SessionManager when an EditorView becomes available for this path —
// we expose `ytext` and `provider.awareness` for that wiring, and
// otherwise know nothing about CodeMirror.

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

    this.provider.awareness?.setLocalStateField("user", opts.user);

    this.persistence = new IndexeddbPersistence(
      `obsidian-collab::${opts.serverUrl}::${room}`,
      this.ydoc,
    );
  }

  // Async factory: create + wait for first sync + seed from disk if Y.Text
  // is genuinely empty. The seed-from-disk decision MUST happen after
  // provider sync — otherwise we'd seed an offline editor's content
  // that later concatenates with whatever the server actually had.
  static async create(opts: TextSessionOptions): Promise<TextSession> {
    const s = new TextSession(opts);
    await Promise.race([
      Promise.all([
        s.persistence.whenSynced,
        waitForProviderSync(s.provider, 4000),
      ]),
      new Promise<void>((r) => setTimeout(r, 4000)),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const providerSynced = (s.provider as any).synced === true;
    if (s.ytext.length === 0 && providerSynced) {
      const file = opts.app.vault.getAbstractFileByPath(opts.path);
      if (file instanceof TFile) {
        try {
          const disk = await opts.app.vault.read(file);
          if (disk.length > 0) {
            s.ytext.insert(0, disk);
            opts.debug(
              `[collab] TextSession ${opts.path}: seeded ${disk.length} chars from disk`,
            );
          }
        } catch (err) {
          log.warn("session", `TextSession ${opts.path}: disk seed failed`, err);
        }
      }
    }
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
