// SPDX-License-Identifier: AGPL-3.0-only
//
// Atomic-text session for .base and similar files. One Y.Map cell
// holds the whole file content; saves replace the entire string, so
// the file on disk is never left half-parsed. Last-writer-wins per
// save — that's intentional, these formats don't tolerate merged
// partial writes.

import { App, TFile } from "obsidian";
import type { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import { removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";

import { log } from "./logger";
import { docIdToRoom, STORAGE_PREFIX } from "./util";
import type { BaseSession } from "./types";

export interface AtomicTextSessionOptions {
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

export class AtomicTextSession implements BaseSession {
  readonly sessionKind = "text" as const;
  readonly docId: string;
  path: string;

  readonly ydoc: Y.Doc;
  readonly provider: HocuspocusProvider;
  readonly persistence: IndexeddbPersistence;
  readonly doc: Y.Map<string>;

  private lastSynced = "";
  private observer: (() => void) | null = null;
  private destroyed = false;

  constructor(private readonly opts: AtomicTextSessionOptions) {
    this.docId = opts.docId;
    this.path = opts.path;

    this.ydoc = new Y.Doc();
    this.doc = this.ydoc.getMap<string>("atomic");

    const room = docIdToRoom(this.docId);
    this.provider = new HocuspocusProvider({
      websocketProvider: opts.socket,
      name: room,
      document: this.ydoc,
      token: opts.authToken || undefined,
    });
    this.provider.attach();

    this.persistence = new IndexeddbPersistence(
      `${STORAGE_PREFIX}::${opts.serverUrl}::${room}`,
      this.ydoc,
    );

    this.provider.awareness?.setLocalStateField("user", opts.user);

    const onChange = () => {
      const next = this.doc.get("content") ?? "";
      if (next === this.lastSynced) return;
      this.lastSynced = next;
      void this.writeToDisk(next);
    };
    this.doc.observe(onChange);
    this.observer = onChange;

    this.provider.on("synced", async () => {
      const remote = this.doc.get("content") ?? "";
      const file = opts.app.vault.getAbstractFileByPath(this.path);
      if (remote.length === 0 && file instanceof TFile) {
        try {
          const local = await opts.app.vault.read(file);
          if (local.length > 0) this.doc.set("content", local);
          this.lastSynced = this.doc.get("content") ?? "";
        } catch (err) {
          log.warn("session", "atomic seed failed", this.path, err);
        }
      } else if (file instanceof TFile) {
        this.lastSynced = remote;
        try {
          const local = await opts.app.vault.read(file);
          if (local !== remote) {
            opts.remoteApplyPaths.add(this.path);
            await opts.app.vault.modify(file, remote);
            setTimeout(() => opts.remoteApplyPaths.delete(this.path), 1000);
          }
        } catch (err) {
          log.warn("binding", "atomic initial write failed", this.path, err);
        }
      }
      opts.debug(
        `[collab] atomic session ${this.path} synced (${remote.length} chars)`,
      );
    });
  }

  async applyDiskUpdate(): Promise<void> {
    const file = this.opts.app.vault.getAbstractFileByPath(this.path);
    if (!(file instanceof TFile)) return;
    try {
      const content = await this.opts.app.vault.read(file);
      if (content === this.lastSynced) return;
      this.doc.set("content", content);
      this.lastSynced = content;
    } catch (err) {
      log.warn("binding", "atomic read-from-disk failed", this.path, err);
    }
  }

  private async writeToDisk(content: string): Promise<void> {
    const file = this.opts.app.vault.getAbstractFileByPath(this.path);
    if (!(file instanceof TFile)) return;
    try {
      const current = await this.opts.app.vault.read(file);
      if (current === content) return;
      this.opts.remoteApplyPaths.add(this.path);
      await this.opts.app.vault.modify(file, content);
      this.opts.debug(
        `[collab] atomic → disk: ${this.path} (${content.length} chars)`,
      );
    } catch (err) {
      log.warn("binding", "atomic write failed", this.path, err);
    } finally {
      setTimeout(() => this.opts.remoteApplyPaths.delete(this.path), 1000);
    }
  }

  wipe(): void {
    if (this.destroyed) return;
    try {
      this.ydoc.transact(() => {
        if (this.doc.has("content")) this.doc.delete("content");
      });
      log.info("session", `AtomicTextSession.wipe: cleared ${this.path}`);
    } catch (err) {
      log.warn("session", `AtomicTextSession.wipe failed`, err);
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.observer) {
      try {
        this.doc.unobserve(this.observer);
      } catch {
        /* ignore */
      }
      this.observer = null;
    }
    try {
      await this.persistence.destroy();
    } catch (err) {
      log.warn("session", "atomic persistence destroy failed", err);
    }
    // v1.0.5 audit F — explicitly clear awareness state so peers see
    // our presence on this file disappear when the session is torn
    // down (file deleted, plugin unloaded). Mirrors TextSession.destroy.
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
    log.info("session", `AtomicTextSession.destroy: ${this.path}`);
  }
}
