// SPDX-License-Identifier: AGPL-3.0-only
//
// Realtime canvas presence — Figma-style cursors + live selection + live
// drag preview + marquee selection rectangles. Canvas is a closed
// custom view so everything here happens via:
//
//   1. DOM listeners on `.canvas-wrapper` for pointer + button state
//   2. Polling of `canvas.selection` and `canvas.nodes` (no public events)
//   3. y-protocols Awareness for low-latency broadcast
//   4. An absolutely-positioned overlay div for remote rendering
//
// Everything ephemeral (cursor position, selection, drag-ghost,
// marquee box) flows through Awareness rather than the Y.Doc — we
// don't want presence churn rewriting the .canvas file on every
// frame. Final settled state (node positions after a drag ends) goes
// through the normal Y.Doc → JSON → disk path when Obsidian's save
// fires.
//
// World vs screen: positions are exchanged in WORLD space so they
// survive different peers' pan/zoom. Screen↔world is recovered by
// probing `canvas.posFromEvt` at three known wrapper-local screen
// points.
//
// Cursor action state mirrors the local OS cursor convention:
//   idle    — arrow over empty canvas
//   hover   — open hand when hovering a node
//   drag    — closed/grabbing hand while actually moving a node
//   marquee — arrow + a dashed selection rectangle on the canvas
//
// Smoothing: peer cursors are interpolated toward their target
// position every animation frame (exponential ease, ~0.25/frame),
// rather than snapping to whichever sample the network just
// delivered. Network samples arrive every ~33 ms throttled plus
// jitter; raw teleporting reads as laggy / stutter even though the
// data is timely. The lerp turns it into smooth motion.

import type { App, WorkspaceLeaf } from "obsidian";
import type { Awareness } from "y-protocols/awareness";

const CURSOR_PUBLISH_MS = 33;     // ~30 Hz throttle on outbound pointer
const SELECTION_POLL_MS = 150;    // node-selection set is bursty, low rate fine
const DRAG_POLL_MS = 33;          // ~30 Hz drag-ghost sampling
const MARQUEE_PUBLISH_MS = 33;    // ~30 Hz marquee-box sampling
// Per-frame easing toward the target. 1 = teleport (no smoothing),
// values near 0.2-0.3 give a "live but not snappy" feel.
const CURSOR_EASE = 0.28;

type ActionKind = "idle" | "hover" | "drag" | "marquee";

interface CanvasAwarenessUser {
  name?: string;
  color?: string;
}

interface CanvasAwarenessPointer {
  x: number;
  y: number;
  mode?: "world" | "screen";
}

interface DragGhost {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Marquee box in WORLD coords. Sender keeps it normalized (width/
// height non-negative) so receiver doesn't have to special-case
// inverted drags.
interface MarqueeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasAwarenessState {
  user?: CanvasAwarenessUser;
  cursor?: CanvasAwarenessPointer | null;
  action?: ActionKind;
  selection?: string[];
  drag?: Record<string, DragGhost> | null;
  marquee?: MarqueeBox | null;
}

// ─── Obsidian Canvas private API surface we depend on ────────────────
// All optional / defensive — undocumented and may differ across
// builds. Every access is guarded.

interface CanvasNodeLike {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface CanvasInternals {
  posFromEvt?: (evt: MouseEvent) => { x: number; y: number };
  nodes?: unknown;     // Map | Set | Array | plain object
  selection?: unknown; // Set | Map | Array | plain object
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

  // ─── Action state machine ─────────────────────────────────────
  //
  // Tracks what the local user is doing right now and broadcasts it
  // via Awareness so peer cursors can switch their SVG and the
  // marquee/drag visuals appear at the right time.
  //
  // The state transitions are inferred from raw DOM events because
  // Canvas doesn't fire helpful semantic events. The rules:
  //
  //   mousemove over .canvas-node     → action = hover (when no button)
  //   mousemove over empty canvas      → action = idle  (when no button)
  //   mousedown on .canvas-node        → action = hover, will promote
  //                                       to "drag" when positions move
  //   mousedown on empty canvas        → action = marquee, publish box
  //   mouseup anywhere                 → clear → hover/idle based on
  //                                       current pointer
  let action: ActionKind = "idle";
  let pressKind: "none" | "node" | "empty" = "none";
  let pressStartWorld: { x: number; y: number } | null = null;
  let overNode = false;
  const setAction = (next: ActionKind) => {
    if (next === action) return;
    action = next;
    awareness.setLocalStateField("action", action);
  };

  // ─── Cursor publish (throttled) ───────────────────────────────
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
    const target = e.target as HTMLElement | null;
    overNode = !!target?.closest?.(".canvas-node");
    if (pressKind === "none") {
      setAction(overNode ? "hover" : "idle");
    } else if (pressKind === "empty" && pressStartWorld) {
      // Marquee drag — recompute the box and publish (throttled
      // by marqueePoll loop, which checks freshness).
      const cur = eventToWorld(view, wrapper, e);
      if (cur) {
        pendingMarqueeEnd = cur;
      }
    }
  };
  const onLeave = () => {
    publishCursor(null);
  };
  // Pointer events (not mouse) so this fires for touch on mobile too —
  // mouse* events don't fire for touch input, which is why canvas
  // presence (cursors / selection / drag preview) was dead or misp
  // -positioned on mobile. PointerEvent extends MouseEvent, so the
  // handlers and posFromEvt calls are unchanged.
  wrapper.addEventListener("pointermove", onMove);
  wrapper.addEventListener("pointerleave", onLeave);

  // ─── Mouse button state ───────────────────────────────────────
  let pendingMarqueeEnd: { x: number; y: number } | null = null;
  let lastPublishedMarquee = "";
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return; // only left-button
    const target = e.target as HTMLElement | null;
    const onNode = !!target?.closest?.(".canvas-node");
    if (onNode) {
      pressKind = "node";
      // Keep showing the open hand until we detect actual movement
      // — promotion to "drag" happens inside the drag-poll below.
      setAction("hover");
    } else {
      pressKind = "empty";
      const start = eventToWorld(view, wrapper, e);
      if (start) {
        pressStartWorld = start;
        pendingMarqueeEnd = start;
      }
      setAction("marquee");
    }
  };
  const onUp = () => {
    pressKind = "none";
    pressStartWorld = null;
    pendingMarqueeEnd = null;
    if (lastPublishedMarquee !== "") {
      awareness.setLocalStateField("marquee", null);
      lastPublishedMarquee = "";
    }
    awareness.setLocalStateField("drag", null);
    lastDragSnapshot = {};
    setAction(overNode ? "hover" : "idle");
  };
  wrapper.addEventListener("pointerdown", onDown);
  // Listen on window for pointerup — pointer often releases outside
  // the wrapper after a drag flick. pointercancel covers touch being
  // interrupted (e.g. the OS steals the gesture).
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);

  // ─── Marquee publish loop ─────────────────────────────────────
  const marqueePoll = window.setInterval(() => {
    if (pressKind !== "empty" || !pressStartWorld || !pendingMarqueeEnd) return;
    const x = Math.min(pressStartWorld.x, pendingMarqueeEnd.x);
    const y = Math.min(pressStartWorld.y, pendingMarqueeEnd.y);
    const width = Math.abs(pressStartWorld.x - pendingMarqueeEnd.x);
    const height = Math.abs(pressStartWorld.y - pendingMarqueeEnd.y);
    const box: MarqueeBox = { x, y, width, height };
    const key = `${x.toFixed(2)}|${y.toFixed(2)}|${width.toFixed(2)}|${height.toFixed(2)}`;
    if (key === lastPublishedMarquee) return;
    lastPublishedMarquee = key;
    awareness.setLocalStateField("marquee", box);
  }, MARQUEE_PUBLISH_MS);

  // ─── Selection set polling ────────────────────────────────────
  let lastSelectionKey = "";
  const selectionPoll = window.setInterval(() => {
    const ids = readSelection(view).sort();
    const key = ids.join("|");
    if (key === lastSelectionKey) return;
    lastSelectionKey = key;
    awareness.setLocalStateField("selection", ids);
  }, SELECTION_POLL_MS);

  // ─── Drag ghost polling ───────────────────────────────────────
  let lastDragSnapshot: Record<string, DragGhost> = {};
  const dragPoll = window.setInterval(() => {
    if (pressKind !== "node") return;
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
    if (moved) setAction("drag");
    if (!shallowGhostEqual(next, lastDragSnapshot)) {
      lastDragSnapshot = next;
      awareness.setLocalStateField("drag", next);
    }
  }, DRAG_POLL_MS);

  // ─── Render loop ──────────────────────────────────────────────
  //
  // rAF-driven. Each frame we step every visible peer's cursor
  // toward its target position by CURSOR_EASE so motion is smooth
  // even when network samples arrive at 30 Hz with jitter.
  // Per-peer cursor interpolation state. We track BOTH the target
  // and the current rendered position in WORLD coordinates (not
  // screen), then project to screen each frame. This is critical:
  // if we lerped in screen space, then pan/zoom would change the
  // projection of the same world point and the cursor would
  // visibly crawl toward its new screen position even though the
  // peer hasn't actually moved. By lerping in world coords, the
  // cursor stays anchored to its world point and reprojects in
  // lockstep with the canvas's own pan/zoom — same as the nodes.
  //
  // `mode` is per-peer because some clients fall back to screen
  // coords when they can't get posFromEvt; for those we keep the
  // lerp in screen space.
  const cursorState = new Map<
    number,
    {
      mode: "world" | "screen";
      tx: number; ty: number; // target
      cx: number; cy: number; // current (rendered)
    }
  >();
  let rafHandle = 0;

  // Single idempotent teardown for THIS wrapper attachment. Called
  // either globally (hook.destroy → cleanups) or self-triggered from
  // the render loop when the wrapper detaches (see below).
  let torn = false;
  const teardown = () => {
    if (torn) return;
    torn = true;
    wrapper.removeEventListener("pointermove", onMove);
    wrapper.removeEventListener("pointerleave", onLeave);
    wrapper.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    window.clearInterval(cursorFlush);
    window.clearInterval(selectionPoll);
    window.clearInterval(dragPoll);
    window.clearInterval(marqueePoll);
    cancelAnimationFrame(rafHandle);
    overlay.remove();
    delete wrapper.dataset.collabAttached;
    awareness.setLocalStateField("cursor", null);
    awareness.setLocalStateField("selection", []);
    awareness.setLocalStateField("drag", null);
    awareness.setLocalStateField("marquee", null);
    awareness.setLocalStateField("action", "idle");
  };

  const tick = () => {
    // Self-clean when Obsidian rebuilds the canvas view. On file
    // switch (and some layout changes) Obsidian destroys the old
    // canvas DOM and builds a fresh `.canvas-wrapper`. Our captured
    // `wrapper` / `view` / `canvas` references then point at detached,
    // stale elements: `getBoundingClientRect()` on a detached node
    // returns zeros/stale values, so the probed world→screen transform
    // goes garbage and peer cursors/selections render at wildly wrong
    // positions (the "positioning breaks until I restart Obsidian"
    // bug — restart wipes the accumulated stale attachments). A fresh
    // attachment to the new wrapper is created by the layout-change
    // listener; this teardown disposes the stale one so only the live
    // attachment (correct transform) survives.
    if (!wrapper.isConnected) {
      teardown();
      return;
    }
    renderRemote(view, wrapper, overlay, awareness, cursorState);
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);

  cleanups.push(teardown);
}

// ─── Helpers ──────────────────────────────────────────────────────────

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

// Like eventToCanvasPos but returns null when world coords aren't
// available — used for marquee start where we strictly need world.
function eventToWorld(
  view: CanvasViewLike,
  _wrapper: HTMLElement,
  evt: MouseEvent,
): { x: number; y: number } | null {
  const canvas = view.canvas;
  if (!canvas || typeof canvas.posFromEvt !== "function") return null;
  try {
    const w = canvas.posFromEvt(evt);
    if (w && Number.isFinite(w.x) && Number.isFinite(w.y)) return w;
  } catch {
    /* fall through */
  }
  return null;
}

interface ScreenFromWorld {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

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

// SVG markup for each cursor variant. We swap the inner HTML when
// `data-cursor-kind` changes so the visual matches the peer's action.
//
// "arrow"  — default Figma-style pointer
// "hand"   — open hand (peer is hovering over a node)
// "grab"   — closed/grabbing hand (peer is moving a node)
//
// Sizes are kept ~22×22 so the hotspot stays in roughly the same
// place across all variants.
const CURSOR_SVG = {
  arrow: `
    <svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 2 L3 17 L7 13 L10 19 L13 18 L10 12 L17 12 Z"
        fill="currentColor" stroke="white" stroke-width="1" />
    </svg>`,
  hand: `
    <svg width="22" height="24" viewBox="0 0 22 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 11 V4.5 a1.4 1.4 0 0 1 2.8 0 V10 M8.8 10 V3 a1.4 1.4 0 0 1 2.8 0 V10 M11.6 10 V3.5 a1.4 1.4 0 0 1 2.8 0 V11 M14.4 11 V5 a1.4 1.4 0 0 1 2.8 0 V14 c0 4-2.6 7-6.6 7 -3.6 0-5.4-2-6.4-5 L2.4 13 a1.3 1.3 0 0 1 1.9-1.7 L6 13 Z"
        fill="currentColor" stroke="white" stroke-width="1" stroke-linejoin="round" stroke-linecap="round" />
    </svg>`,
  grab: `
    <svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 10 V7 a1.3 1.3 0 0 1 2.6 0 V9.5 M7.6 9.5 V5.5 a1.3 1.3 0 0 1 2.6 0 V9.5 M10.2 9.5 V6 a1.3 1.3 0 0 1 2.6 0 V10 M12.8 10 V7 a1.3 1.3 0 0 1 2.6 0 V13 c0 3.5-2.4 6-6 6 -3.2 0-5-1.8-5.8-4.5 L2 12 a1.2 1.2 0 0 1 1.8-1.6 L5 12 Z"
        fill="currentColor" stroke="white" stroke-width="1" stroke-linejoin="round" stroke-linecap="round" />
    </svg>`,
};

function cursorKindFor(action: ActionKind): "arrow" | "hand" | "grab" {
  switch (action) {
    case "hover":
      return "hand";
    case "drag":
      return "grab";
    case "marquee":
    case "idle":
    default:
      return "arrow";
  }
}

function renderRemote(
  view: CanvasViewLike,
  wrapper: HTMLElement,
  overlay: HTMLDivElement,
  awareness: Awareness,
  cursorState: Map<
    number,
    {
      mode: "world" | "screen";
      tx: number; ty: number;
      cx: number; cy: number;
    }
  >,
) {
  const localId = awareness.clientID;
  const states = awareness.getStates();
  const xform = deriveScreenFromWorld(view, wrapper);
  const rect = wrapper.getBoundingClientRect();

  const seenCursor = new Set<number>();
  const seenSelection = new Set<string>();
  const seenDrag = new Set<string>();
  const seenMarquee = new Set<number>();

  states.forEach((stateRaw, clientId) => {
    if (clientId === localId) return;
    const state = stateRaw as CanvasAwarenessState;
    const color = state.user?.color ?? "#888";
    const name = state.user?.name ?? "anonymous";
    const action: ActionKind = state.action ?? "idle";

    // ── Selection outlines ──────────────────────────────────────
    if (state.selection && state.selection.length > 0) {
      for (const nodeId of state.selection) {
        const node = findNodeById(view, nodeId);
        if (!node || !xform) continue;
        const wx = numOr(node.x, NaN);
        const wy = numOr(node.y, NaN);
        const ww = numOr(node.width, NaN);
        const wh = numOr(node.height, NaN);
        if (!Number.isFinite(wx) || !Number.isFinite(wy)) continue;
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

    // ── Drag ghosts ─────────────────────────────────────────────
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

    // ── Marquee selection rectangle ─────────────────────────────
    if (state.marquee && xform) {
      const m = state.marquee;
      const tl = worldToScreen(xform, m.x, m.y);
      const w = m.width * xform.scaleX;
      const h = m.height * xform.scaleY;
      seenMarquee.add(clientId);
      let el = overlay.querySelector(
        `[data-marquee-client="${clientId}"]`,
      ) as HTMLDivElement | null;
      if (!el) {
        el = document.createElement("div");
        el.className = "collab-canvas-marquee";
        el.dataset.marqueeClient = String(clientId);
        overlay.appendChild(el);
      }
      el.style.transform = `translate(${tl.x}px, ${tl.y}px)`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.borderColor = color;
      el.style.backgroundColor = hexWithAlpha(color, 0.08);
    }

    // ── Cursor with smoothing ───────────────────────────────────
    //
    // Interpolation happens in WORLD coords when we have them, so
    // the cursor stays glued to its world point during pan/zoom
    // (cards move; cursor moves with them, exact same projection).
    // For peers that publish only screen coords (no posFromEvt on
    // their build) we fall back to screen-space lerp.
    const cursor = state.cursor;
    if (cursor && typeof cursor.x === "number" && typeof cursor.y === "number") {
      const sampleMode: "world" | "screen" =
        cursor.mode === "world" ? "world" : "screen";

      let st = cursorState.get(clientId);
      // Snap distance is mode-dependent: world coords aren't bound
      // by pixel scale, so a generous threshold keeps the lerp from
      // crawling across a big canvas teleport while still smoothing
      // ordinary motion.
      const SNAP_SQ = sampleMode === "world" ? 4000 * 4000 : 500 * 500;
      if (!st || st.mode !== sampleMode) {
        st = {
          mode: sampleMode,
          tx: cursor.x,
          ty: cursor.y,
          cx: cursor.x,
          cy: cursor.y,
        };
        cursorState.set(clientId, st);
      } else {
        st.tx = cursor.x;
        st.ty = cursor.y;
        const dx = st.tx - st.cx;
        const dy = st.ty - st.cy;
        if (dx * dx + dy * dy > SNAP_SQ) {
          st.cx = st.tx;
          st.cy = st.ty;
        } else {
          st.cx += dx * CURSOR_EASE;
          st.cy += dy * CURSOR_EASE;
        }
      }

      // Project to screen NOW, after the lerp, using the current
      // frame's transform. Pan/zoom updates xform; cursor stays
      // anchored to its world position with no crawl.
      let screenX: number;
      let screenY: number;
      if (st.mode === "world") {
        if (!xform) {
          // World-space coords but we couldn't derive this frame's
          // world→screen transform (e.g. the probe failed). Rendering at
          // raw world values would fling the cursor far off-screen / to a
          // wrong spot — the exact "cursor in the wrong place" symptom.
          // Skip drawing it this frame; the post-loop GC removes any stale
          // node since we never add this client to seenCursor. Selections,
          // drag ghosts and marquee already skip on `!xform` the same way.
          return;
        }
        const p = worldToScreen(xform, st.cx, st.cy);
        screenX = p.x;
        screenY = p.y;
      } else {
        // screen-mode peer (a build without posFromEvt): raw wrapper-local
        // screen coords are the best signal we have.
        screenX = st.cx;
        screenY = st.cy;
      }

      if (
        screenX < -120 ||
        screenY < -120 ||
        screenX > rect.width + 120 ||
        screenY > rect.height + 120
      ) {
        const stale = overlay.querySelector(`[data-client-id="${clientId}"]`);
        stale?.remove();
        cursorState.delete(clientId);
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
            <span class="collab-canvas-cursor-svg-wrap"></span>
            <span class="collab-canvas-cursor-label"></span>
          `;
          overlay.appendChild(el);
        }
        el.style.transform = `translate(${screenX}px, ${screenY}px)`;
        el.style.color = color;
        el.dataset.action = action;

        const kind = cursorKindFor(action);
        if (el.dataset.cursorKind !== kind) {
          el.dataset.cursorKind = kind;
          const wrap = el.querySelector(
            ".collab-canvas-cursor-svg-wrap",
          ) as HTMLSpanElement | null;
          if (wrap) wrap.innerHTML = CURSOR_SVG[kind];
        }

        const label = el.querySelector(
          ".collab-canvas-cursor-label",
        ) as HTMLSpanElement;
        if (label) {
          if (label.textContent !== name) label.textContent = name;
          label.style.backgroundColor = color;
        }
      }
    } else {
      // No cursor for this peer — drop interpolation state so a
      // future cursor doesn't lerp from a stale point.
      cursorState.delete(clientId);
    }
  });

  // ─── Garbage-collect overlay nodes for vanished state ─────────
  overlay.querySelectorAll("[data-client-id]").forEach((el) => {
    const id = parseInt((el as HTMLElement).dataset.clientId ?? "", 10);
    if (!seenCursor.has(id)) {
      el.remove();
      cursorState.delete(id);
    }
  });
  overlay.querySelectorAll("[data-selection-key]").forEach((el) => {
    const key = (el as HTMLElement).dataset.selectionKey ?? "";
    if (!seenSelection.has(key)) el.remove();
  });
  overlay.querySelectorAll("[data-drag-key]").forEach((el) => {
    const key = (el as HTMLElement).dataset.dragKey ?? "";
    if (!seenDrag.has(key)) el.remove();
  });
  overlay.querySelectorAll("[data-marquee-client]").forEach((el) => {
    const id = parseInt((el as HTMLElement).dataset.marqueeClient ?? "", 10);
    if (!seenMarquee.has(id)) el.remove();
  });
}

function hexWithAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
