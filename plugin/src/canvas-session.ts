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

import { App, TFile, type WorkspaceLeaf } from "obsidian";
import type { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

import { docIdToRoom, STORAGE_PREFIX } from "./util";
import { attachCanvasCursors, type CanvasCursorHook } from "./canvas-cursors";
import type { BaseSession } from "./types";

interface CanvasJson {
  nodes: Array<Record<string, unknown> & { id?: string }>;
  edges: Array<Record<string, unknown> & { id?: string }>;
  [key: string]: unknown;
}

// ─── Obsidian Canvas private API surface (undocumented) ──────────────
// Everything here is feature-detected at the call site; if a build is
// missing a method we fall back to the disk path and never throw.
interface CanvasNodeLike {
  id?: string;
}

interface CanvasInternals {
  nodes?: unknown; // Map<id, node> | Set | Array | object
  selection?: unknown;
  getData?: () => CanvasJson;
  setData?: (data: CanvasJson) => void;
  importData?: (data: CanvasJson) => void;
  requestSave?: (...args: unknown[]) => unknown;
  requestFrame?: () => void;
}

interface CanvasViewLike {
  file?: { path: string } | null;
  canvas?: CanvasInternals;
  getViewType?: () => string;
}

// Transaction origin for our live-view → Y capture. Lets the deep
// observer distinguish "the local open canvas just changed, push to
// disk but NOT back into the view" from "a remote peer changed it,
// push to disk AND into the view".
const CANVAS_LOCAL_ORIGIN = "canvas-local";

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

  // ── Live-view bridge state ──────────────────────────────────────────
  // The currently-attached open canvas view for this.path (null when the
  // canvas is closed → we fall back to the pure disk path).
  private liveCanvas: CanvasInternals | null = null;
  private liveView: CanvasViewLike | null = null;
  // The original requestSave we monkey-patched, so we can restore it on
  // detach/destroy.
  private patchedRequestSave: ((...args: unknown[]) => unknown) | null = null;
  // Guard: true while we are pushing remote/Y state INTO the live view.
  // Our setData/importData triggers the canvas's own requestSave; this
  // flag makes the patched requestSave skip the capture so we never echo
  // a remote change straight back into Y.
  private applyingRemote = false;
  // Serialized snapshot of what we last pushed into the live view, used
  // to skip no-op applies (and to avoid clobbering identical state).
  private lastAppliedToView = "";
  // workspace listeners for attach/detach on open/close.
  private layoutOff: (() => void) | null = null;
  // Poll fallback handle (only used if requestSave isn't patchable).
  private capturePollHandle = 0;
  // Drag-capture handle: while the mouse button is held over the canvas,
  // Obsidian often defers requestSave until the drag ENDS, so peers see a
  // card teleport from start→end instead of moving. This light poll
  // captures intermediate positions DURING the drag. It only does work
  // while a button is down (CanvasSession.mouseDown) and the canonical
  // gate in captureFromLiveView drops no-op frames, so idle cost is ~zero.
  private dragCaptureHandle = 0;

  constructor(private readonly opts: CanvasSessionOptions) {
    this.docId = opts.docId;
    this.path = opts.path;

    // Cheap shared mouse-button tracker for the interaction guard.
    CanvasSession.installMouseTracker();

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
      `${STORAGE_PREFIX}::${opts.serverUrl}::${room}`,
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

    // The deep observer must know WHERE a change came from so it routes
    // correctly and never loops. Yjs hands us the transaction whose
    // commit fired the observer; its `origin` tells us:
    //
    //   origin === this.provider  → a REMOTE peer's edit arrived over the
    //                               websocket. Push to disk (so closed
    //                               peers stay current) AND into the live
    //                               open view (so the local viewer sees it).
    //   origin === CANVAS_LOCAL_ORIGIN → our OWN live-view→Y capture. The
    //                               change is already in the open view by
    //                               construction; only push to disk. Do
    //                               NOT re-apply to the view (would loop).
    //   anything else (null seed / applyDiskUpdate / wipe) → push to disk
    //                               AND into the live view. When the canvas
    //                               is closed (the only time applyDiskUpdate
    //                               runs) the view apply is a guarded no-op.
    const onDeep = (
      _events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
      tr: Y.Transaction,
    ) => {
      const json = this.buildJson();
      const serialized = JSON.stringify(json, null, "\t");
      const fromLocalCapture = tr.origin === CANVAS_LOCAL_ORIGIN;

      // Disk path (unchanged behaviour): keep the .canvas file current so
      // closed peers and other plugins see settled state. Skipped when the
      // serialized content hasn't changed.
      if (serialized !== this.lastSerialized) {
        this.lastSerialized = serialized;
        void this.writeToDisk(serialized);
      }

      // Live-view path: only for changes that did NOT originate from the
      // live view itself (those are already on screen). This is the
      // anti-echo gate #2 (gate #1 is the applyingRemote flag around the
      // setData call, which stops the capture from firing in the first
      // place).
      if (!fromLocalCapture) {
        this.applyToLiveView(json, serialized);
      }
    };
    this.nodes.observeDeep(onDeep);
    this.edges.observeDeep(onDeep);
    this.meta.observeDeep(onDeep);
    this.deepObserverOff = () => {
      this.nodes.unobserveDeep(onDeep);
      this.edges.unobserveDeep(onDeep);
      this.meta.unobserveDeep(onDeep);
    };

    // Attach the live-view bridge now and on every layout/active-leaf
    // change, mirroring how canvas-cursors discovers the open canvas.
    // This makes the bridge attach when the canvas opens and detach when
    // it closes (the canvas object/DOM is rebuilt on close → detected via
    // isConnected-style re-evaluation in tryAttachLiveView).
    const tryAttach = () => this.tryAttachLiveView();
    opts.app.workspace.on("layout-change", tryAttach);
    opts.app.workspace.on("active-leaf-change", tryAttach);
    this.layoutOff = () => {
      opts.app.workspace.off("layout-change", tryAttach);
      opts.app.workspace.off("active-leaf-change", tryAttach);
    };
    // Defer the first attempt to the next tick so the constructor's
    // provider/persistence wiring settles first.
    window.setTimeout(tryAttach, 0);

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

  // ── Live-view bridge: attach / detach ──────────────────────────────

  // Find the open canvas leaf whose file matches this.path. Attaches the
  // bridge if found and not already attached; detaches if our previously
  // attached canvas object is gone or stale (canvas closed / rebuilt).
  private tryAttachLiveView(): void {
    if (this.destroyed) return;
    let found: { view: CanvasViewLike; canvas: CanvasInternals } | null = null;
    try {
      const leaves = this.opts.app.workspace.getLeavesOfType("canvas");
      for (const leaf of leaves as WorkspaceLeaf[]) {
        const view = leaf.view as unknown as CanvasViewLike;
        if (view?.getViewType?.() !== "canvas") continue;
        if (view.file?.path !== this.path) continue;
        const canvas = view.canvas;
        if (canvas && typeof canvas === "object") {
          found = { view, canvas };
          break;
        }
      }
    } catch (err) {
      console.warn("[collab] canvas live-view lookup failed", this.path, err);
    }

    // Already attached to the same live canvas object → nothing to do.
    if (found && found.canvas === this.liveCanvas) return;

    // Different or no canvas now → detach the old one first.
    if (this.liveCanvas) this.detachLiveView();

    if (!found) return;

    this.attachLiveView(found.view, found.canvas);
  }

  private attachLiveView(view: CanvasViewLike, canvas: CanvasInternals): void {
    // Feature-detect the read API we need to capture local edits. Without
    // getData we cannot diff the view into Y; fall back to the disk path.
    if (typeof canvas.getData !== "function") {
      console.warn(
        "[collab] canvas.getData absent on this build; canvas live sync " +
          "falls back to disk path for",
        this.path,
      );
      return;
    }

    this.liveView = view;
    this.liveCanvas = canvas;

    // Capture strategy: monkey-patch requestSave (chosen over polling).
    // Rationale: Obsidian calls canvas.requestSave() precisely when it
    // decides canvas state changed and should persist — node moves,
    // colour/text edits, add/remove. Wrapping it gives us an exact,
    // event-driven hook at ~zero idle cost, versus a 10 Hz poll that
    // burns CPU while the canvas merely sits open. If requestSave is
    // absent or not a function we degrade to a 10 Hz poll; if getData is
    // also unusable we already returned above (disk fallback).
    const orig = canvas.requestSave;
    if (typeof orig === "function") {
      const bound = orig.bind(canvas);
      this.patchedRequestSave = bound;
      const self = this;
      canvas.requestSave = function patchedRequestSave(
        this: unknown,
        ...args: unknown[]
      ) {
        const ret = bound(...args);
        // Skip capture while WE are the ones writing into the view.
        if (!self.applyingRemote) self.captureFromLiveView();
        return ret;
      };
      this.opts.debug(
        `[collab] canvas live bridge attached (requestSave patch) ${this.path}`,
      );
    } else {
      // Poll fallback.
      this.capturePollHandle = window.setInterval(() => {
        if (this.applyingRemote) return;
        this.captureFromLiveView();
      }, 100);
      this.opts.debug(
        `[collab] canvas live bridge attached (poll fallback) ${this.path}`,
      );
    }

    // Drag-capture poll: catch in-progress node moves that Obsidian only
    // persists (requestSave) on drop. Gated on mouseDown so it's idle when
    // nothing is happening; captureFromLiveView's canonical gate makes
    // repeat frames at the same position free.
    this.dragCaptureHandle = window.setInterval(() => {
      if (this.applyingRemote) return;
      if (!CanvasSession.mouseDown) return;
      this.captureFromLiveView();
    }, 120);

    // Seed: ensure the open view reflects current Y state immediately on
    // attach (e.g. canvas opened after a peer already edited it). This is
    // a Y→view push, guarded by applyingRemote so it doesn't capture-loop.
    const json = this.buildJson();
    this.applyToLiveView(json, JSON.stringify(json, null, "\t"));
  }

  private detachLiveView(): void {
    const canvas = this.liveCanvas;
    if (canvas && this.patchedRequestSave) {
      try {
        // Restore the original requestSave. We stored the bound original;
        // assigning it back removes our wrapper.
        canvas.requestSave = this.patchedRequestSave as CanvasInternals["requestSave"];
      } catch (err) {
        console.warn("[collab] canvas requestSave restore failed", err);
      }
    }
    this.patchedRequestSave = null;
    if (this.capturePollHandle) {
      window.clearInterval(this.capturePollHandle);
      this.capturePollHandle = 0;
    }
    if (this.dragCaptureHandle) {
      window.clearInterval(this.dragCaptureHandle);
      this.dragCaptureHandle = 0;
    }
    this.liveCanvas = null;
    this.liveView = null;
    this.lastAppliedToView = "";
  }

  // ── Live view → Y (capture local edits immediately) ─────────────────
  private captureFromLiveView(): void {
    const canvas = this.liveCanvas;
    if (!canvas || typeof canvas.getData !== "function") return;
    let data: CanvasJson | null = null;
    try {
      data = canvas.getData();
    } catch (err) {
      console.warn("[collab] canvas.getData threw", this.path, err);
      return;
    }
    if (!data || typeof data !== "object") return;

    const serialized = this.canonicalize(data);
    // Nothing changed since we last saw the view → skip (also covers the
    // requestSave that fires right after our own applyToLiveView setData,
    // since that path sets lastAppliedToView to the same content). The
    // canonical form means a cosmetic-only diff (key order / sub-pixel
    // float) is treated as "no change" and never re-enters Y — this is
    // what breaks the perpetual disk-write loop.
    if (serialized === this.lastAppliedToView) return;
    this.lastAppliedToView = serialized;

    // Diff into Y under our origin tag so the deep observer routes this to
    // disk only and NEVER back into the view.
    this.ydoc.transact(() => {
      this.applyJson(data as CanvasJson);
    }, CANVAS_LOCAL_ORIGIN);
  }

  // ── Y → live view (remote/seed edits appear live) ───────────────────
  private applyToLiveView(json: CanvasJson, serialized: string): void {
    const canvas = this.liveCanvas;
    if (!canvas) return;

    // Skip if the view already holds this exact content (avoids needless
    // re-render and breaks any residual echo). Canonical comparison so a
    // cosmetic-only diff doesn't force a redundant setData.
    const normalized = this.canonicalize(json);
    if (normalized === this.lastAppliedToView) return;

    // Interaction guard: if the local user is mid-interaction (something
    // selected AND a mouse button is currently down), defer the whole
    // apply briefly so we don't yank a card out from under their drag.
    // We re-check on a short timer; worst case the remote update lands a
    // few hundred ms late, which is far better than disrupting the drag.
    if (this.localUserBusy()) {
      window.setTimeout(() => {
        if (this.destroyed || this.liveCanvas !== canvas) return;
        this.applyToLiveView(json, serialized);
      }, 150);
      return;
    }

    const apply = canvas.setData ?? canvas.importData;
    if (typeof apply !== "function") {
      // No way to push into the live view on this build. The disk write
      // already happened in onDeep; the open view simply won't update
      // live (it will pick up the change if reopened). Warn once-ish.
      console.warn(
        "[collab] canvas.setData/importData absent; open view will not " +
          "live-update for",
        this.path,
      );
      return;
    }

    this.applyingRemote = true;
    try {
      apply.call(canvas, json);
      // Record what the view now holds so the capture path (and any
      // requestSave our setData triggered) treats it as a no-op.
      this.lastAppliedToView = normalized;
      // Re-render only. Do NOT call requestSave here — that would trigger
      // our capture → Y → observer cycle. (Even though applyingRemote
      // guards the capture, we still avoid the needless disk churn.)
      try {
        canvas.requestFrame?.();
      } catch {
        /* non-fatal */
      }
    } catch (err) {
      console.warn("[collab] canvas setData/importData threw", this.path, err);
    } finally {
      // Release on the next tick: setData may schedule a synchronous
      // requestSave that we want suppressed; clearing immediately could
      // race it. A microtask/0ms timer keeps the guard up across that
      // synchronous burst.
      window.setTimeout(() => {
        this.applyingRemote = false;
      }, 0);
    }
  }

  // True when the local user appears to be actively manipulating the
  // canvas: a non-empty selection AND a mouse button held down. We read
  // selection off the canvas object (same shape canvas-cursors reads) and
  // mouse-button state off a lightweight global tracker installed lazily.
  private localUserBusy(): boolean {
    const canvas = this.liveCanvas;
    if (!canvas) return false;
    if (!CanvasSession.mouseDown) return false;
    const sel = canvas.selection;
    if (sel == null) return false;
    if (sel instanceof Set || sel instanceof Map) return sel.size > 0;
    if (Array.isArray(sel)) return sel.length > 0;
    if (typeof sel === "object") return Object.keys(sel).length > 0;
    return false;
  }

  // Global left-button-down tracker, shared across all CanvasSession
  // instances. Installed once. canvas-cursors tracks its own press state
  // privately and we must not touch it, so we keep an independent, cheap
  // window-level listener here.
  private static mouseDown = false;
  private static mouseTrackerInstalled = false;
  private static installMouseTracker(): void {
    if (CanvasSession.mouseTrackerInstalled) return;
    CanvasSession.mouseTrackerInstalled = true;
    const clear = () => {
      CanvasSession.mouseDown = false;
    };
    // Desktop: mouse buttons.
    window.addEventListener(
      "mousedown",
      (e) => {
        if ((e as MouseEvent).button === 0) CanvasSession.mouseDown = true;
      },
      true,
    );
    window.addEventListener("mouseup", clear, true);
    // Mobile: touch/pen via pointer events (mouse pointers already covered
    // above, so ignore pointerType "mouse" to avoid redundant work).
    window.addEventListener(
      "pointerdown",
      (e) => {
        const pe = e as PointerEvent;
        if (pe.pointerType !== "mouse" && pe.button === 0) {
          CanvasSession.mouseDown = true;
        }
      },
      true,
    );
    window.addEventListener("pointerup", clear, true);
    window.addEventListener("pointercancel", clear, true);
  }

  // Canonical, comparison-only serialization. Two peers that hold the
  // SAME logical canvas state must produce the SAME string here, even if
  // their canvas.getData() differs cosmetically — otherwise the
  // capture→Y→setData→getData→capture cycle never settles and the
  // ".canvas" file ping-pongs forever (the 166↔167-byte loop seen in the
  // logs). Two cosmetic sources of drift are neutralized:
  //   1. Object KEY ORDER — getData() on device A and a setData round-trip
  //      on device B can emit the same fields in a different order.
  //   2. Sub-pixel FLOAT drift in node geometry (x/y/width/height) — a
  //      drag/snap can leave 100 vs 100.0000001; rounding to whole pixels
  //      (canvas geometry is integer-grained in practice) erases it.
  // This is used ONLY for the change-detection gates in captureFromLiveView
  // and applyToLiveView. The values actually written into Y / to disk are
  // never rounded or reordered — only the equality test is canonicalized.
  private static readonly GEOM_KEYS = new Set(["x", "y", "width", "height"]);
  private canonicalize(value: unknown, key?: string): string {
    if (value === null || typeof value !== "object") {
      if (
        typeof value === "number" &&
        key !== undefined &&
        CanvasSession.GEOM_KEYS.has(key)
      ) {
        return JSON.stringify(Math.round(value));
      }
      return JSON.stringify(value === undefined ? null : value);
    }
    if (Array.isArray(value)) {
      return "[" + value.map((v) => this.canonicalize(v)).join(",") + "]";
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + this.canonicalize(obj[k], k))
        .join(",") +
      "}"
    );
  }

  // Rename hook — re-attach the canvas presence overlay against the
  // new path so leaf filtering keeps working.
  onPathChanged(newPath: string) {
    // The live bridge is keyed on the old path; detach and re-discover
    // against the new path (mirrors the cursor-hook re-attach below).
    this.detachLiveView();
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
    this.tryAttachLiveView();
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
    // Restore monkey-patched requestSave, clear poll, drop live refs.
    try {
      this.detachLiveView();
    } catch (err) {
      console.warn("[collab] canvas live-view detach failed", err);
    }
    // Remove workspace listeners.
    try {
      this.layoutOff?.();
    } catch {
      /* ignore */
    }
    this.layoutOff = null;
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
