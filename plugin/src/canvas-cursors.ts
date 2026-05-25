// SPDX-License-Identifier: AGPL-3.0-only
//
// Live cursor overlay for Obsidian Canvas views — world-space.
//
// Canvas is a closed custom view; we can't bind to it like CodeMirror.
// Instead we attach DOM listeners to `.canvas-wrapper`, publish the
// pointer position via Awareness, and render every other user's
// pointer as an absolutely-positioned overlay div.
//
// Coordinates travel in WORLD space — i.e. the same logical document
// point regardless of each peer's pan/zoom. That requires converting
// between screen pixels and world coords using Obsidian's canvas
// transform.
//
// Obsidian exposes `canvas.posFromEvt(evt) → {x, y}` which does the
// screen→world conversion correctly. The reverse (world→screen) isn't
// exposed cleanly, and the obvious `canvas.x/y/zoom` properties had
// non-standard sign conventions in 0.7.0 that produced mirrored
// cursors. Rather than guess the formula again we PROBE the transform
// at render time: synthesize three MouseEvents at known wrapper-local
// screen points (origin, +100x, +100y), feed them through posFromEvt
// to read out their world coords, and from those derive the affine
// inverse. Works on any Obsidian build whose canvas exposes
// posFromEvt, no matter what the underlying pan/zoom representation
// looks like.

import type { App, WorkspaceLeaf } from "obsidian";
import type { Awareness } from "y-protocols/awareness";

// Throttle publish to ~30 Hz — anything faster just wastes traffic.
const PUBLISH_INTERVAL_MS = 33;
// Re-render at most this often. rAF-driven, this is the cap.
const RENDER_INTERVAL_MS = 50;

interface CanvasAwarenessUser {
  name?: string;
  color?: string;
}

// Pointer published into Awareness. `mode` lets us evolve the coord
// system without breaking older peers — "world" means a world-space
// point from posFromEvt; "screen" means wrapper-local pixels (used as
// fallback when the local canvas has no posFromEvt).
interface CanvasAwarenessPointer {
  x: number;
  y: number;
  mode?: "world" | "screen";
}

interface CanvasAwarenessState {
  user?: CanvasAwarenessUser;
  cursor?: CanvasAwarenessPointer | null;
}

interface CanvasInternals {
  posFromEvt?: (evt: MouseEvent) => { x: number; y: number };
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

  let lastPublish = 0;
  let pendingPos: CanvasAwarenessPointer | null = null;

  const publish = (pos: CanvasAwarenessPointer | null) => {
    if (pos === null) {
      awareness.setLocalStateField("cursor", null);
      pendingPos = null;
      return;
    }
    const now = Date.now();
    pendingPos = pos;
    if (now - lastPublish < PUBLISH_INTERVAL_MS) return;
    lastPublish = now;
    awareness.setLocalStateField("cursor", pendingPos);
  };

  const onMove = (e: MouseEvent) => {
    publish(eventToCanvasPos(view, wrapper, e));
  };
  const onLeave = () => publish(null);

  wrapper.addEventListener("mousemove", onMove);
  wrapper.addEventListener("mouseleave", onLeave);

  const flushInterval = window.setInterval(() => {
    if (!pendingPos) return;
    const now = Date.now();
    if (now - lastPublish < PUBLISH_INTERVAL_MS) return;
    lastPublish = now;
    awareness.setLocalStateField("cursor", pendingPos);
  }, PUBLISH_INTERVAL_MS);

  let rafHandle = 0;
  let lastRender = 0;
  const tick = () => {
    const now = Date.now();
    if (now - lastRender >= RENDER_INTERVAL_MS) {
      lastRender = now;
      renderRemoteCursors(view, wrapper, overlay, awareness);
    }
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);

  cleanups.push(() => {
    wrapper.removeEventListener("mousemove", onMove);
    wrapper.removeEventListener("mouseleave", onLeave);
    window.clearInterval(flushInterval);
    cancelAnimationFrame(rafHandle);
    overlay.remove();
    delete wrapper.dataset.collabAttached;
    awareness.setLocalStateField("cursor", null);
  });
}

// Convert a real MouseEvent into a CanvasAwarenessPointer suitable
// for the wire. If posFromEvt is available, publish world coords; if
// not, fall back to wrapper-local pixels and tag the mode so peers
// know not to apply the inverse transform.
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
  // Linear: screen.x = scaleX * (world.x - offsetX)
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

// Probe canvas.posFromEvt at known wrapper-local screen points to
// derive the world→screen inverse without having to know the canvas
// internals' sign / scale conventions. Returns null when the canvas
// doesn't expose posFromEvt or its samples are degenerate.
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
    const dxw = B.x - A.x; // world delta for +100 px screen X
    const dyw = C.y - A.y; // world delta for +100 px screen Y
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

function renderRemoteCursors(
  view: CanvasViewLike,
  wrapper: HTMLElement,
  overlay: HTMLDivElement,
  awareness: Awareness,
) {
  const localId = awareness.clientID;
  const states = awareness.getStates();
  const seen = new Set<number>();
  const xform = deriveScreenFromWorld(view, wrapper);
  const rect = wrapper.getBoundingClientRect();

  states.forEach((stateRaw, clientId) => {
    if (clientId === localId) return;
    const state = stateRaw as CanvasAwarenessState;
    const cursor = state.cursor;
    if (!cursor || typeof cursor.x !== "number" || typeof cursor.y !== "number") {
      return;
    }
    const mode = cursor.mode ?? "screen";

    let screenX: number;
    let screenY: number;
    if (mode === "world" && xform) {
      screenX = (cursor.x - xform.offsetX) * xform.scaleX;
      screenY = (cursor.y - xform.offsetY) * xform.scaleY;
    } else {
      // Mode is "screen" (peer couldn't get world coords) or we
      // can't derive the transform locally — render as wrapper-
      // relative pixels. Cursor direction stays correct; absolute
      // position only matches when both peers are at the same
      // pan/zoom.
      screenX = cursor.x;
      screenY = cursor.y;
    }

    // Hide cursors well outside the wrapper to avoid keeping DOM
    // around for far-off pointers (it would still render, just off
    // the visible area).
    if (
      screenX < -100 ||
      screenY < -100 ||
      screenX > rect.width + 100 ||
      screenY > rect.height + 100
    ) {
      const stale = overlay.querySelector(`[data-client-id="${clientId}"]`);
      stale?.remove();
      return;
    }
    seen.add(clientId);

    const color = state.user?.color ?? "#888";
    const name = state.user?.name ?? "anonymous";

    let el = overlay.querySelector(
      `[data-client-id="${clientId}"]`,
    ) as HTMLDivElement | null;
    if (!el) {
      el = document.createElement("div");
      el.dataset.clientId = String(clientId);
      el.className = "collab-canvas-cursor";
      el.innerHTML = `
        <svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
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
    const label = el.querySelector(
      ".collab-canvas-cursor-label",
    ) as HTMLSpanElement;
    if (label) {
      if (label.textContent !== name) label.textContent = name;
      label.style.backgroundColor = color;
    }
  });

  overlay.querySelectorAll("[data-client-id]").forEach((el) => {
    const id = parseInt((el as HTMLElement).dataset.clientId ?? "", 10);
    if (!seen.has(id)) el.remove();
  });
}
