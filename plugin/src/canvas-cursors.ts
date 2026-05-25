// SPDX-License-Identifier: AGPL-3.0-only
//
// Live cursor overlay for Obsidian Canvas views.
//
// Canvas in Obsidian is a closed custom view (not CodeMirror), so we
// can't bind to it the same way we bind to markdown editors. Instead
// we attach DOM listeners to the .canvas-wrapper element, publish the
// mouse position into the canvas session's Awareness, and render
// remote users' pointers as absolutely-positioned overlay DOM nodes.
//
// Coordinates are stored in WORLD space — i.e. canvas-internal
// coordinates that don't change with pan/zoom. Each viewer transforms
// world → screen using their own canvas pan/zoom state, so two users
// looking at the same logical point in the canvas see the cursor at
// the same conceptual place regardless of how each has panned/zoomed.
//
// We poke into the private Obsidian canvas API (`view.canvas`,
// `canvas.posFromEvt`, `canvas.x/y/tx/ty/zoom/tZoom`) with defensive
// fallbacks. The plugin keeps working even if any of those names
// change in a future Obsidian release — the cursor overlay just goes
// quiet on that one canvas.

import type { App, WorkspaceLeaf } from "obsidian";
import type { Awareness } from "y-protocols/awareness";

// Throttle pointer publishing to ~30 Hz. Higher than this just wastes
// network traffic without any visible smoothness gain.
const PUBLISH_INTERVAL_MS = 33;

// Re-render overlay this often when the canvas itself isn't dispatching
// awareness events (e.g. local user panned, remote cursor still at the
// same world coords but its screen position needs updating). Driven by
// rAF, this is the maximum delay.
const RENDER_INTERVAL_MS = 50;

interface CanvasAwarenessUser {
  name?: string;
  color?: string;
}

interface CanvasAwarenessPointer {
  x: number;
  y: number;
}

interface CanvasAwarenessState {
  user?: CanvasAwarenessUser;
  // `cursor` is reused for markdown sessions' editor cursor, but on
  // canvas sessions it stores a world-space pointer. They never mix
  // because each .canvas file has its own session / Awareness.
  cursor?: CanvasAwarenessPointer;
}

interface CanvasInternals {
  // Pan offset in world units. Different Obsidian builds have called
  // these `x/y`, `tx/ty`, or `posX/posY` — we try each.
  x?: number;
  y?: number;
  tx?: number;
  ty?: number;
  // Current zoom factor. Often `zoom` for the rendered value and
  // `tZoom` for the animated target.
  zoom?: number;
  tZoom?: number;
  // page-to-world conversion supplied by Obsidian. If present we use
  // it; otherwise we approximate from x/y/zoom + the wrapper's
  // boundingClientRect.
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

// Attach the cursor publisher + overlay renderer to every canvas
// view currently showing `filePath`. Returns a hook with a destroy()
// that removes the listeners + overlay DOM cleanly. The plugin
// should also re-call this whenever a new canvas leaf opens for the
// same path; existing hooks are idempotent (no double-attach).
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

  // Initial pass — covers canvases already open.
  tryAttach();

  // Re-scan on layout changes so newly-opened canvas leaves get the
  // overlay too. Cheap — iterateAllLeaves is in-memory.
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

  // Idempotency: one overlay div per wrapper. If we've already
  // attached, skip — the renderer is still running.
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
    const world = pageToWorld(view, wrapper, e);
    if (!world) return;
    publish(world);
  };

  const onLeave = () => publish(null);

  wrapper.addEventListener("mousemove", onMove);
  wrapper.addEventListener("mouseleave", onLeave);

  // Flush trailing publish on the way out so the cursor doesn't get
  // stuck at the second-to-last position.
  const flushInterval = window.setInterval(() => {
    if (!pendingPos) return;
    const now = Date.now();
    if (now - lastPublish < PUBLISH_INTERVAL_MS) return;
    lastPublish = now;
    awareness.setLocalStateField("cursor", pendingPos);
  }, PUBLISH_INTERVAL_MS);

  // Render loop: redraw overlay positions on rAF tick. Driven by rAF
  // (not by awareness 'change') because local pan/zoom doesn't fire
  // any awareness event, but the remote cursor's screen position
  // needs to follow.
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

// Convert a page-space MouseEvent into canvas world coordinates.
// Tries Obsidian's `posFromEvt` first, then falls back to the
// boundingClientRect + canvas.x/y/zoom triangulation.
function pageToWorld(
  view: CanvasViewLike,
  wrapper: HTMLElement,
  evt: MouseEvent,
): CanvasAwarenessPointer | null {
  const canvas = view.canvas;
  if (!canvas) return null;
  if (typeof canvas.posFromEvt === "function") {
    try {
      const p = canvas.posFromEvt(evt);
      if (typeof p?.x === "number" && typeof p?.y === "number") return p;
    } catch {
      // fall through to manual computation
    }
  }
  const rect = wrapper.getBoundingClientRect();
  const zoom = canvas.zoom ?? canvas.tZoom ?? 1;
  const panX = canvas.x ?? canvas.tx ?? 0;
  const panY = canvas.y ?? canvas.ty ?? 0;
  // Screen coordinate relative to the wrapper, divided by zoom, then
  // shifted by canvas pan. This is the world coordinate.
  const sx = evt.clientX - rect.left;
  const sy = evt.clientY - rect.top;
  return {
    x: sx / zoom - panX,
    y: sy / zoom - panY,
  };
}

// Inverse of pageToWorld: from world coordinates to screen-relative
// pixels inside the wrapper.
function worldToScreen(
  view: CanvasViewLike,
  pos: CanvasAwarenessPointer,
): { x: number; y: number } | null {
  const canvas = view.canvas;
  if (!canvas) return null;
  const zoom = canvas.zoom ?? canvas.tZoom ?? 1;
  const panX = canvas.x ?? canvas.tx ?? 0;
  const panY = canvas.y ?? canvas.ty ?? 0;
  return {
    x: (pos.x + panX) * zoom,
    y: (pos.y + panY) * zoom,
  };
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

  states.forEach((stateRaw, clientId) => {
    if (clientId === localId) return;
    const state = stateRaw as CanvasAwarenessState;
    const cursor = state.cursor;
    if (!cursor || typeof cursor.x !== "number") return;
    const screen = worldToScreen(view, cursor);
    if (!screen) return;
    // Skip cursors outside the visible wrapper (just to avoid keeping
    // DOM nodes for far-off pointers; an extra-large viewport would
    // still pick them up).
    const rect = wrapper.getBoundingClientRect();
    if (
      screen.x < -100 ||
      screen.y < -100 ||
      screen.x > rect.width + 100 ||
      screen.y > rect.height + 100
    ) {
      // still remove existing cursor for this client if any
      const stale = overlay.querySelector(
        `[data-client-id="${clientId}"]`,
      );
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
    el.style.transform = `translate(${screen.x}px, ${screen.y}px)`;
    el.style.color = color;
    const label = el.querySelector(
      ".collab-canvas-cursor-label",
    ) as HTMLSpanElement;
    if (label) {
      if (label.textContent !== name) label.textContent = name;
      label.style.backgroundColor = color;
    }
  });

  // Remove cursors of clients that aren't broadcasting any more.
  overlay.querySelectorAll("[data-client-id]").forEach((el) => {
    const id = parseInt(
      (el as HTMLElement).dataset.clientId ?? "",
      10,
    );
    if (!seen.has(id)) el.remove();
  });
}
