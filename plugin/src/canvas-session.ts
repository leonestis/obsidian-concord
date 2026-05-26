// SPDX-License-Identifier: AGPL-3.0-only
//
// Canvas session — reconstructed from the 0.9.x openCanvasSession code.
// Logic is byte-identical to the original (parse, diff-apply, build,
// observe, write-on-change) — the only structural change is that the
// Y.Doc room is now `doc:<uuid>` instead of `file:<path>`. The path
// argument is still threaded through because attachCanvasCursors (the
// rock-solid canvas presence layer in ./canvas-cursors.ts) uses it for
// leaf filtering, and we don't touch canvas-cursors per the task
// brief.

import { App, TFile } from "obsidian";
import type { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

import { docIdToRoom } from "./util";
import { attachCanvasCursors, type CanvasCursorHook } from "./canvas-cursors";
import type { BaseSession } from "./types";

interface CanvasJson {
  nodes: Array<Record<string, unknown> & { id?: string }>;
  edges: Array<Record<string, unknown> & { id?: string }>;
  [key: string]: unknown;
}

export interface CanvasSessionOptions {
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

export class CanvasSession implements BaseSession {
  readonly sessionKind = "canvas" as const;
  readonly docId: string;
  path: string;

  readonly ydoc: Y.Doc;
  readonly provider: HocuspocusProvider;
  readonly persistence: IndexeddbPersistence;
  readonly nodes: Y.Map<Y.Map<unknown>>;
  readonly edges: Y.Map<Y.Map<unknown>>;
  readonly meta: Y.Map<unknown>;

  private lastSerialized = "";
  private deepObserverOff: () => void = () => {};
  private cursorHook: CanvasCursorHook | null = null;
  private destroyed = false;

  constructor(private readonly opts: CanvasSessionOptions) {
    this.docId = opts.docId;
    this.path = opts.path;

    this.ydoc = new Y.Doc();
    this.nodes = this.ydoc.getMap<Y.Map<unknown>>("canvas.nodes");
    this.edges = this.ydoc.getMap<Y.Map<unknown>>("canvas.edges");
    this.meta = this.ydoc.getMap<unknown>("canvas.meta");

    const room = docIdToRoom(this.docId);
    this.provider = new HocuspocusProvider({
      websocketProvider: opts.socket,
      name: room,
      document: this.ydoc,
      token: opts.authToken || undefined,
    });
    this.provider.attach();

    this.persistence = new IndexeddbPersistence(
      `obsidian-collab::${opts.serverUrl}::${room}`,
      this.ydoc,
    );

    this.provider.awareness?.setLocalStateField("user", opts.user);

    // Canvas presence overlay. attachCanvasCursors is path-keyed
    // internally; pass the current path. On rename, SessionManager
    // will tear down + recreate the hook with the new path.
    if (this.provider.awareness) {
      this.cursorHook = attachCanvasCursors(
        opts.app,
        this.path,
        this.provider.awareness,
      );
    }

    const onDeep = () => {
      const json = this.buildJson();
      const serialized = JSON.stringify(json, null, "\t");
      if (serialized === this.lastSerialized) return;
      this.lastSerialized = serialized;
      void this.writeToDisk(serialized);
    };
    this.nodes.observeDeep(onDeep);
    this.edges.observeDeep(onDeep);
    this.meta.observeDeep(onDeep);
    this.deepObserverOff = () => {
      this.nodes.unobserveDeep(onDeep);
      this.edges.unobserveDeep(onDeep);
      this.meta.unobserveDeep(onDeep);
    };

    this.provider.on("synced", async () => {
      const file = opts.app.vault.getAbstractFileByPath(this.path);
      const hasYState =
        this.nodes.size > 0 || this.edges.size > 0 || this.meta.size > 0;
      if (!hasYState && file instanceof TFile) {
        try {
          const raw = await opts.app.vault.read(file);
          if (raw.trim().length > 0) {
            const parsed = this.safeParseCanvas(raw);
            if (parsed) this.applyJson(parsed);
            this.lastSerialized = JSON.stringify(this.buildJson(), null, "\t");
          }
        } catch (err) {
          console.warn("[collab] canvas seed failed", this.path, err);
        }
      } else if (hasYState && file instanceof TFile) {
        const json = this.buildJson();
        const serialized = JSON.stringify(json, null, "\t");
        this.lastSerialized = serialized;
        try {
          const current = await opts.app.vault.read(file);
          if (current !== serialized) {
            opts.remoteApplyPaths.add(this.path);
            await opts.app.vault.modify(file, serialized);
            setTimeout(() => opts.remoteApplyPaths.delete(this.path), 1000);
          }
        } catch (err) {
          console.warn("[collab] canvas initial write failed", this.path, err);
        }
      }
      opts.debug(
        `[collab] canvas session ${this.path} synced (nodes=${this.nodes.size}, edges=${this.edges.size})`,
      );
    });
  }

  // Called by manifest-sync.ts when the local user modifies the canvas
  // file on disk (Obsidian's normal save flow). Diff the file onto Y.
  async applyDiskUpdate(): Promise<void> {
    const file = this.opts.app.vault.getAbstractFileByPath(this.path);
    if (!(file instanceof TFile)) return;
    try {
      const raw = await this.opts.app.vault.read(file);
      const parsed = this.safeParseCanvas(raw);
      if (!parsed) return;
      this.applyJson(parsed);
      this.lastSerialized = JSON.stringify(this.buildJson(), null, "\t");
    } catch (err) {
      console.warn(
        "[collab] canvas read-from-disk failed",
        this.path,
        err,
      );
    }
  }

  // Rename hook — re-attach the canvas presence overlay against the
  // new path so leaf filtering keeps working.
  onPathChanged(newPath: string) {
    this.path = newPath;
    this.cursorHook?.destroy();
    this.cursorHook = null;
    if (this.provider.awareness) {
      this.cursorHook = attachCanvasCursors(
        this.opts.app,
        this.path,
        this.provider.awareness,
      );
    }
  }

  wipe(): void {
    if (this.destroyed) return;
    try {
      this.ydoc.transact(() => {
        for (const id of Array.from(this.nodes.keys())) this.nodes.delete(id);
        for (const id of Array.from(this.edges.keys())) this.edges.delete(id);
        for (const k of Array.from(this.meta.keys())) this.meta.delete(k);
      });
      console.log(`[collab] CanvasSession.wipe: cleared maps for ${this.path}`);
    } catch (err) {
      console.warn(`[collab] CanvasSession.wipe failed for ${this.path}`, err);
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.deepObserverOff();
    } catch {
      /* ignore */
    }
    this.cursorHook?.destroy();
    this.cursorHook = null;
    try {
      await this.persistence.destroy();
    } catch (err) {
      console.warn("[collab] canvas persistence destroy failed", err);
    }
    this.provider.destroy();
    this.ydoc.destroy();
    console.log(`[collab] CanvasSession.destroy: ${this.path}`);
  }

  // ── canvas (de)serialisation ─────────────────────────────────────────

  private safeParseCanvas(raw: string): CanvasJson | null {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return null;
      return parsed as CanvasJson;
    } catch (err) {
      console.warn(`[collab] cannot parse canvas ${this.path}`, err);
      return null;
    }
  }

  private applyJson(json: CanvasJson) {
    this.ydoc.transact(() => {
      // Nodes
      const incomingNodeIds = new Set<string>();
      for (const n of json.nodes ?? []) {
        if (!n || typeof n.id !== "string") continue;
        incomingNodeIds.add(n.id);
        let map = this.nodes.get(n.id);
        if (!map) {
          map = new Y.Map();
          this.nodes.set(n.id, map);
        }
        const { id: _id, ...rest } = n;
        void _id;
        this.diffApplyMap(map, rest);
      }
      for (const id of Array.from(this.nodes.keys())) {
        if (!incomingNodeIds.has(id)) this.nodes.delete(id);
      }
      // Edges
      const incomingEdgeIds = new Set<string>();
      for (const e of json.edges ?? []) {
        if (!e || typeof e.id !== "string") continue;
        incomingEdgeIds.add(e.id);
        let map = this.edges.get(e.id);
        if (!map) {
          map = new Y.Map();
          this.edges.set(e.id, map);
        }
        const { id: _id, ...rest } = e;
        void _id;
        this.diffApplyMap(map, rest);
      }
      for (const id of Array.from(this.edges.keys())) {
        if (!incomingEdgeIds.has(id)) this.edges.delete(id);
      }
      // Top-level meta — everything that's not nodes/edges.
      const metaIncoming: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(json)) {
        if (key === "nodes" || key === "edges") continue;
        metaIncoming[key] = value;
      }
      this.diffApplyMap(this.meta, metaIncoming);
    });
  }

  private diffApplyMap(target: Y.Map<unknown>, src: Record<string, unknown>) {
    for (const [key, value] of Object.entries(src)) {
      const cur = target.get(key);
      if (JSON.stringify(cur) !== JSON.stringify(value)) target.set(key, value);
    }
    for (const key of Array.from(target.keys())) {
      if (!(key in src)) target.delete(key);
    }
  }

  private buildJson(): CanvasJson {
    const out: CanvasJson = { nodes: [], edges: [] };
    for (const [key, value] of this.meta.entries()) {
      if (key === "nodes" || key === "edges") continue;
      (out as Record<string, unknown>)[key] = value;
    }
    const nodeIds = Array.from(this.nodes.keys()).sort();
    for (const id of nodeIds) {
      const map = this.nodes.get(id);
      if (!map) continue;
      const obj: Record<string, unknown> = { id };
      for (const [k, v] of map.entries()) obj[k] = v;
      out.nodes.push(obj);
    }
    const edgeIds = Array.from(this.edges.keys()).sort();
    for (const id of edgeIds) {
      const map = this.edges.get(id);
      if (!map) continue;
      const obj: Record<string, unknown> = { id };
      for (const [k, v] of map.entries()) obj[k] = v;
      out.edges.push(obj);
    }
    return out;
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
        `[collab] canvas → disk: ${this.path} (${content.length} chars)`,
      );
    } catch (err) {
      console.warn("[collab] canvas write failed", this.path, err);
    } finally {
      setTimeout(() => this.opts.remoteApplyPaths.delete(this.path), 1000);
    }
  }
}
