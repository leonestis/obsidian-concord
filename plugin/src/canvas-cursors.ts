// SPDX-License-Identifier: AGPL-3.0-only
//
// Realtime canvas presence — Figma-style cursors + live selection + live
// drag preview. We can't bind to Canvas the way we do to CodeMirror
// because it's a closed custom view, so everything here happens via:
//
//   1. DOM listeners on `.canvas-wrapper` (mouse position, button state)
//   2. Polling of `canvas.selection` and `canvas.nodes` (no public events)
//   3. y-protocols Awareness for low-latency broadcast
//   4. An absolutely-positioned overlay div for remote rendering
//
// Everything ephemeral (cursor position, selection, "I'm currently
// dragging node X to (px, py)") goes through Awareness rather than
// Y.Doc — we don't want presence churn rewriting the .canvas file on
// every frame. Permanent state (the eventual settled node position
// after a drag ends) flows through the existing Y.Doc → JSON → disk
// path when Obsidian saves the canvas naturally.
//
// World vs screen coords: positions are exchanged in WORLD space (the
// canvas's logical document coordinate system) so they survive
// different peers' pan/zoom. We derive a screen↔world transform by
// probing `canvas.posFromEvt` at three known wrapper-local screen
// points, which works regardless of how the canvas internals
// represent pan/zoom.
//
// Node positions (x, y, width, height) are ALREADY in world space —
// they come straight off the canvas node objects.
//
// Action state on the cursor: idle / selecting / dragging. The cursor
// SVG and a small action badge changes accordingly so peers can see
// what their collaborators are doing, like in Figma.
//
// All polling intervals and thresholds are tuned for "looks live" at
// 30 Hz while keeping per-frame work cheap.

import type { App, WorkspaceLeaf } from "obsidian";
import type { Awareness } from "y-protocols/awareness";

const CURSOR_PUBLISH_MS = 33;     // ~30 Hz cursor throttle
const SELECTION_POLL_MS = 150;    // selection is bursty, low-rate ok
const DRAG_POLL_MS = 33;          // ~30 Hz drag-ghost updates
const RENDER_INTERVAL_MS = 33;    // ~30 Hz overlay redraw

type ActionKind = "idle" | "selecting" | "dragging";

interface CanvasAwarenessUser {
  name?: string;
  color?: string;
}

// Cursor pointer published into Awareness.
interface CanvasAwarenessPointer {
  x: number;
  y: number;
  mode?: "world" | "screen";
}

// "Where peer is dragging selected nodes to" — world coords + size so
// remote can render a ghost rectangle even when their copy of the node
// has different (still-old) coords.
interface DragGhost {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasAwarenessState {
  user?: CanvasAwarenessUser;
  cursor?: CanvasAwarenessPointer | null;
  action?: ActionKind;
  // Sorted array of node ids in the peer's current selection.
  selection?: string[];
  // Map of nodeId → ghost rect, only populated while peer is dragging.
  drag?: Record<string, DragGhost> | null;
}

// ─── Obsidian Canvas private API surface we depend on ──────────────────
// All optional / defensive — Canvas is undocumented and may differ
// across builds. Every access is guarded.

interface CanvasNodeLike {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface CanvasInternals {
  posFromEvt?: (evt: MouseEvent) => { x: number; y: number };
  // Could be Map<id, node>, Set<node>, or array — we normalise.
  nodes?: unknown;
  // Could be Set<node>, Map<id, node>, or array.
  selection?: unknown;
}

interface CanvasViewLike {
  file?: { path: string } | null;
  contentEl?: HTMLElement;
  canvas?: CanvasInternals;
  getViewType?: () => string;
}

export interface CanvasCursorHook {
  destroy: () => void;
}

export function attachCanvasCursors(
  app: App,
  filePath: string,
  awareness: Awareness,
): CanvasCursorHook {
  const cleanups: Array<() => void> = [];

  const tryAttach = () => {
    app.workspace.iterateAllLeaves((leaf) => {
      attachToLeafIfCanvas(leaf, filePath, awareness, cleanups);
    });
  };

  tryAttach();
  const onLayout = () => tryAttach();
  app.workspace.on("layout-change", onLayout);
  app.workspace.on("active-leaf-change", onLayout);
  cleanups.push(() => {
    app.workspace.off("layout-change", onLayout);
    app.workspace.off("active-leaf-change", onLayout);
  });

  return {
    destroy() {
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch (err) {
          console.warn("[collab] canvas cursor cleanup failed", err);
        }
      }
    },
  };
}

function attachToLeafIfCanvas(
  leaf: WorkspaceLeaf,
  filePath: string,
  awareness: Awareness,
  cleanups: Array<() => void>,
) {
  const view = leaf.view as unknown as CanvasViewLike;
  if (view?.getViewType?.() !== "canvas") return;
  if (view.file?.path !== filePath) return;

  const wrapper = view.contentEl?.querySelector(
    ".canvas-wrapper",
  ) as HTMLElement | null;
  if (!wrapper) return;

  if (wrapper.dataset.collabAttached === "1") return;
  wrapper.dataset.collabAttached = "1";

  const overlay = document.createElement("div");
  overlay.className = "collab-canvas-overlay";
  wrapper.appendChild(overlay);

  // ─── Cursor publish (throttled) ──────────────────────────────────
  let lastCursorPublish = 0;
  let pendingCursor: CanvasAwarenessPointer | null = null;
  const publishCursor = (pos: CanvasAwarenessPointer | null) => {
    if (pos === null) {
      awareness.setLocalStateField("cursor", null);
      pendingCursor = null;
      return;
    }
    pendingCursor = pos;
    const now = Date.now();
    if (now - lastCursorPublish < CURSOR_PUBLISH_MS) return;
    lastCursorPublish = now;
    awareness.setLocalStateField("cursor", pendingCursor);
  };
  const cursorFlush = window.setInterval(() => {
    if (!pendingCursor) return;
    const now = Date.now();
    if (now - lastCursorPublish < CURSOR_PUBLISH_MS) return;
    lastCursorPublish = now;
    awareness.setLocalStateField("cursor", pendingCursor);
  }, CURSOR_PUBLISH_MS);

  const onMove = (e: MouseEvent) => {
    publishCursor(eventToCanvasPos(view, wrapper, e));
  };
  const onLeave = () => publishCursor(null);
  wrapper.addEventListener("mousemove", onMove);
  wrapper.addEventListener("mouseleave", onLeave);

  // ─── Action state (mousedown / mouseup) ──────────────────────────
  //
  // We don't know up-front whether mousedown means "click selecting"
  // or "starting a drag". Strategy: when the button goes down we mark
  // action=selecting; if the selected-node positions then change while
  // the button stays down, we promote to action=dragging. On mouseup
  // we go back to idle and clear any drag ghosts.
  let action: ActionKind = "idle";
  let mouseDown = false;
  const setAction = (next: ActionKind) => {
    if (next === action) return;
    action = next;
    awareness.setLocalStateField("action", action);
  };
  const onDown = () => {
    mouseDown = true;
    setAction("selecting");
  };
  const onUp = () => {
    mouseDown = false;
    setAction("idle");
    // Drop drag ghosts so peers stop seeing the floating rectangle —
    // the real position will arrive via the normal save-file path.
    awareness.setLocalStateField("drag", null);
    lastDragSnapshot = {};
  };
  wrapper.addEventListener("mousedown", onDown);
  // Listen on window for mouseup — pointer often releases outside
  // the wrapper after a drag flick.
  window.addEventListener("mouseup", onUp);

  // ─── Selection polling ───────────────────────────────────────────
  let lastSelectionKey = "";
  const selectionPoll = window.setInterval(() => {
    const ids = readSelection(view).sort();
    const key = ids.join("|");
    if (key === lastSelectionKey) return;
    lastSelectionKey = key;
    awareness.setLocalStateField("selection", ids);
  }, SELECTION_POLL_MS);

  // ─── Drag ghost polling ──────────────────────────────────────────
  //
  // While the mouse button is held AND we have a non-empty selection,
  // sample the selected nodes' world positions and publish them as
  // a per-id ghost rect. We compare against a snapshot to detect
  // genuine movement vs. just a static selection.
  let lastDragSnapshot: Record<string, DragGhost> = {};
  const dragPoll = window.setInterval(() => {
    if (!mouseDown) return;
    const ids = readSelection(view);
    if (ids.length === 0) return;
    const next: Record<string, DragGhost> = {};
    let moved = false;
    for (const id of ids) {
      const node = findNodeById(view, id);
      if (!node) continue;
      const x = numOr(node.x, 0);
      const y = numOr(node.y, 0);
      const w = numOr(node.width, 0);
      const h = numOr(node.height, 0);
      next[id] = { x, y, width: w, height: h };
      const prev = lastDragSnapshot[id];
      if (!prev || prev.x !== x || prev.y !== y) moved = true;
    }
    // Promote action to "dragging" the first time we see movement
    // while the mouse is held — until then it's still "selecting".
    if (moved) setAction("dragging");
    // Publish even when not moved (yet), so peers see something the
    // moment we start; but cheap-compare against last to avoid churn.
    if (!shallowGhostEqual(next, lastDragSnapshot)) {
      lastDragSnapshot = next;
      awareness.setLocalStateField("drag", next);
    }
  }, DRAG_POLL_MS);

  // ─── Render loop ─────────────────────────────────────────────────
  let rafHandle = 0;
  let lastRender = 0;
  const tick = () => {
    const now = Date.now();
    if (now - lastRender >= RENDER_INTERVAL_MS) {
      lastRender = now;
      renderRemote(view, wrapper, overlay, awareness);
    }
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);

  cleanups.push(() => {
    wrapper.removeEventListener("mousemove", onMove);
    wrapper.removeEventListener("mouseleave", onLeave);
    wrapper.removeEventListener("mousedown", onDown);
    window.removeEventListener("mouseup", onUp);
    window.clearInterval(cursorFlush);
    window.clearInterval(selectionPoll);
    window.clearInterval(dragPoll);
    cancelAnimationFrame(rafHandle);
    overlay.remove();
    delete wrapper.dataset.collabAttached;
    awareness.setLocalStateField("cursor", null);
    awareness.setLocalStateField("selection", []);
    awareness.setLocalStateField("drag", null);
    awareness.setLocalStateField("action", "idle");
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────

function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function shallowGhostEqual(
  a: Record<string, DragGhost>,
  b: Record<string, DragGhost>,
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (!y) return false;
    if (x.x !== y.x || x.y !== y.y || x.width !== y.width || x.height !== y.height) {
      return false;
    }
  }
  return true;
}

// Iterate over canvas.nodes regardless of whether it's a Map/Set/Array.
function iterCanvasNodes(view: CanvasViewLike): CanvasNodeLike[] {
  const c = view.canvas;
  if (!c || !c.nodes) return [];
  const out: CanvasNodeLike[] = [];
  const nodes = c.nodes as unknown;
  if (nodes instanceof Map) {
    nodes.forEach((n) => out.push(n as CanvasNodeLike));
  } else if (nodes instanceof Set) {
    nodes.forEach((n) => out.push(n as CanvasNodeLike));
  } else if (Array.isArray(nodes)) {
    for (const n of nodes) out.push(n as CanvasNodeLike);
  } else if (typeof nodes === "object") {
    for (const v of Object.values(nodes as Record<string, unknown>)) {
      out.push(v as CanvasNodeLike);
    }
  }
  return out;
}

function findNodeById(view: CanvasViewLike, id: string): CanvasNodeLike | null {
  const c = view.canvas;
  if (!c || !c.nodes) return null;
  const nodes = c.nodes as unknown;
  if (nodes instanceof Map) {
    const direct = nodes.get(id);
    if (direct) return direct as CanvasNodeLike;
  }
  for (const n of iterCanvasNodes(view)) {
    if (n && n.id === id) return n;
  }
  return null;
}

function readSelection(view: CanvasViewLike): string[] {
  const c = view.canvas;
  if (!c || c.selection == null) return [];
  const out: string[] = [];
  const sel = c.selection as unknown;
  const push = (n: unknown) => {
    const id = (n as CanvasNodeLike | undefined)?.id;
    if (typeof id === "string") out.push(id);
  };
  if (sel instanceof Set) {
    sel.forEach(push);
  } else if (sel instanceof Map) {
    sel.forEach(push);
  } else if (Array.isArray(sel)) {
    for (const v of sel) push(v);
  } else if (typeof sel === "object") {
    for (const v of Object.values(sel as Record<string, unknown>)) push(v);
  }
  return out;
}

function eventToCanvasPos(
  view: CanvasViewLike,
  wrapper: HTMLElement,
  evt: MouseEvent,
): CanvasAwarenessPointer {
  const canvas = view.canvas;
  if (canvas && typeof canvas.posFromEvt === "function") {
    try {
      const w = canvas.posFromEvt(evt);
      if (
        w &&
        typeof w.x === "number" &&
        typeof w.y === "number" &&
        Number.isFinite(w.x) &&
        Number.isFinite(w.y)
      ) {
        return { x: w.x, y: w.y, mode: "world" };
      }
    } catch (err) {
      console.warn("[collab] posFromEvt threw on local event", err);
    }
  }
  const rect = wrapper.getBoundingClientRect();
  return {
    x: evt.clientX - rect.left,
    y: evt.clientY - rect.top,
    mode: "screen",
  };
}

interface ScreenFromWorld {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

// Probe canvas.posFromEvt at three known wrapper-local screen points
// to derive the world→screen affine inverse. Returns null when
// posFromEvt is unavailable or samples are degenerate.
function deriveScreenFromWorld(
  view: CanvasViewLike,
  wrapper: HTMLElement,
): ScreenFromWorld | null {
  const canvas = view.canvas;
  if (!canvas || typeof canvas.posFromEvt !== "function") return null;
  const rect = wrapper.getBoundingClientRect();
  try {
    const make = (clientX: number, clientY: number) =>
      new MouseEvent("mousemove", { clientX, clientY });
    const A = canvas.posFromEvt(make(rect.left, rect.top));
    const B = canvas.posFromEvt(make(rect.left + 100, rect.top));
    const C = canvas.posFromEvt(make(rect.left, rect.top + 100));
    if (
      !A ||
      !B ||
      !C ||
      !Number.isFinite(A.x) ||
      !Number.isFinite(A.y) ||
      !Number.isFinite(B.x) ||
      !Number.isFinite(C.y)
    ) {
      return null;
    }
    const dxw = B.x - A.x;
    const dyw = C.y - A.y;
    if (Math.abs(dxw) < 1e-9 || Math.abs(dyw) < 1e-9) return null;
    return {
      scaleX: 100 / dxw,
      scaleY: 100 / dyw,
      offsetX: A.x,
      offsetY: A.y,
    };
  } catch (err) {
    console.warn("[collab] failed to derive canvas transform", err);
    return null;
  }
}

function worldToScreen(
  xform: ScreenFromWorld,
  wx: number,
  wy: number,
): { x: number; y: number } {
  return {
    x: (wx - xform.offsetX) * xform.scaleX,
    y: (wy - xform.offsetY) * xform.scaleY,
  };
}

function renderRemote(
  view: CanvasViewLike,
  wrapper: HTMLElement,
  overlay: HTMLDivElement,
  awareness: Awareness,
) {
  const localId = awareness.clientID;
  const states = awareness.getStates();
  const xform = deriveScreenFromWorld(view, wrapper);
  const rect = wrapper.getBoundingClientRect();

  const seenCursor = new Set<number>();
  const seenSelection = new Set<string>(); // `${clientId}:${nodeId}`
  const seenDrag = new Set<string>();      // `${clientId}:${nodeId}`

  states.forEach((stateRaw, clientId) => {
    if (clientId === localId) return;
    const state = stateRaw as CanvasAwarenessState;
    const color = state.user?.color ?? "#888";
    const name = state.user?.name ?? "anonymous";
    const action: ActionKind = state.action ?? "idle";

    // ── Selection outlines ────────────────────────────────────────
    if (state.selection && state.selection.length > 0) {
      for (const nodeId of state.selection) {
        const node = findNodeById(view, nodeId);
        if (!node || !xform) continue;
        const wx = numOr(node.x, NaN);
        const wy = numOr(node.y, NaN);
        const ww = numOr(node.width, NaN);
        const wh = numOr(node.height, NaN);
        if (!Number.isFinite(wx) || !Number.isFinite(wy)) continue;
        // Skip the selection outline if this node is also being
        // drag-ghosted by the same peer — the ghost rect covers it.
        if (state.drag && state.drag[nodeId]) continue;
        const tl = worldToScreen(xform, wx, wy);
        const w = ww * xform.scaleX;
        const h = wh * xform.scaleY;
        const key = `${clientId}:${nodeId}`;
        seenSelection.add(key);
        let el = overlay.querySelector(
          `[data-selection-key="${key}"]`,
        ) as HTMLDivElement | null;
        if (!el) {
          el = document.createElement("div");
          el.className = "collab-canvas-selection";
          el.dataset.selectionKey = key;
          overlay.appendChild(el);
        }
        el.style.transform = `translate(${tl.x}px, ${tl.y}px)`;
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.style.borderColor = color;
        el.style.boxShadow = `0 0 0 1px ${color} inset`;
      }
    }

    // ── Drag ghosts ───────────────────────────────────────────────
    if (state.drag && xform) {
      for (const [nodeId, ghost] of Object.entries(state.drag)) {
        if (!ghost) continue;
        const tl = worldToScreen(xform, ghost.x, ghost.y);
        const w = ghost.width * xform.scaleX;
        const h = ghost.height * xform.scaleY;
        const key = `${clientId}:${nodeId}`;
        seenDrag.add(key);
        let el = overlay.querySelector(
          `[data-drag-key="${key}"]`,
        ) as HTMLDivElement | null;
        if (!el) {
          el = document.createElement("div");
          el.className = "collab-canvas-drag-ghost";
          el.dataset.dragKey = key;
          overlay.appendChild(el);
        }
        el.style.transform = `translate(${tl.x}px, ${tl.y}px)`;
        el.style.width = `${w}px`;
        el.style.height = `${h}px`;
        el.style.borderColor = color;
        el.style.backgroundColor = hexWithAlpha(color, 0.15);
      }
    }

    // ── Cursor ────────────────────────────────────────────────────
    const cursor = state.cursor;
    if (cursor && typeof cursor.x === "number" && typeof cursor.y === "number") {
      const mode = cursor.mode ?? "screen";
      let screenX: number;
      let screenY: number;
      if (mode === "world" && xform) {
        const p = worldToScreen(xform, cursor.x, cursor.y);
        screenX = p.x;
        screenY = p.y;
      } else {
        screenX = cursor.x;
        screenY = cursor.y;
      }
      // Hide cursors far outside the viewport.
      if (
        screenX < -120 ||
        screenY < -120 ||
        screenX > rect.width + 120 ||
        screenY > rect.height + 120
      ) {
        const stale = overlay.querySelector(`[data-client-id="${clientId}"]`);
        stale?.remove();
      } else {
        seenCursor.add(clientId);
        let el = overlay.querySelector(
          `[data-client-id="${clientId}"]`,
        ) as HTMLDivElement | null;
        if (!el) {
          el = document.createElement("div");
          el.dataset.clientId = String(clientId);
          el.className = "collab-canvas-cursor";
          el.innerHTML = `
            <svg class="collab-canvas-cursor-svg" width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
              <path d="M3 2 L3 17 L7 13 L10 19 L13 18 L10 12 L17 12 Z"
                fill="currentColor"
                stroke="white"
                stroke-width="1" />
            </svg>
            <span class="collab-canvas-cursor-label"></span>
          `;
          overlay.appendChild(el);
        }
        el.style.transform = `translate(${screenX}px, ${screenY}px)`;
        el.style.color = color;
        el.dataset.action = action;
        const label = el.querySelector(
          ".collab-canvas-cursor-label",
        ) as HTMLSpanElement;
        if (label) {
          const text =
            action === "dragging"
              ? `${name} · dragging`
              : action === "selecting"
              ? `${name} · selecting`
              : name;
          if (label.textContent !== text) label.textContent = text;
          label.style.backgroundColor = color;
        }
      }
    }
  });

  // ─── Garbage-collect overlay nodes for vanished state ───────────
  overlay.querySelectorAll("[data-client-id]").forEach((el) => {
    const id = parseInt((el as HTMLElement).dataset.clientId ?? "", 10);
    if (!seenCursor.has(id)) el.remove();
  });
  overlay.querySelectorAll("[data-selection-key]").forEach((el) => {
    const key = (el as HTMLElement).dataset.selectionKey ?? "";
    if (!seenSelection.has(key)) el.remove();
  });
  overlay.querySelectorAll("[data-drag-key]").forEach((el) => {
    const key = (el as HTMLElement).dataset.dragKey ?? "";
    if (!seenDrag.has(key)) el.remove();
  });
}

// "#rrggbb" + alpha → "rgba(r,g,b,a)". Falls back to the input if
// the string isn't a 6-digit hex.
function hexWithAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
