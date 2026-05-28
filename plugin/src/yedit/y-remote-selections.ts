// SPDX-License-Identifier: MIT
// See LICENSE.upstream (yjs/y-codemirror.next) and LICENSE.relay (No-Instructions/Relay).
//
// Remote cursors / selections. Mirrors upstream's `yRemoteSelections` but
// with the same dynamic-context trick as y-sync.ts: the awareness this
// plugin listens to is resolved on every update() and every awareness
// event, not captured in the constructor.
//
// This file owns:
//   - Subscribing to the active session's awareness `change` event and
//     scheduling a redraw whenever a remote client's state changes.
//   - Rebuilding the DecorationSet (selection highlights + caret widget
//     for each remote client whose cursor is set and points at OUR
//     ytext).
//   - Publishing OUR cursor position into the active awareness on
//     selection / focus changes. (The `user` field is owned by
//     LocalPresenceController — a single source of truth across all
//     bound sessions; this plugin only writes `cursor`.)
//
// On a context switch (different docId than last seen), we subscribe to
// the new awareness's `change` events and unsubscribe from the old.
//
// We NEVER remove or null the local awareness state from here — that is
// owned exclusively by LocalPresenceController (active/inactive +
// identity) and TextSession.destroy() (final teardown). This plugin's
// only write to the local state is the live cursor coordinate, and it
// does so in a way that can't wipe the identity: if the local state is
// somehow still null when we go to publish (presence's broadcast hasn't
// landed yet), we write a FULL { user, cursor } object using the `user`
// threaded through YeditContext, rather than a setLocalStateField that
// would silently no-op on a null state.

import {
  Annotation,
  RangeSet,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { resolveContextFacet, type ResolveContext } from "./y-sync";

// Annotation we use to trigger an editor dispatch when awareness fires
// outside the normal update flow. The dispatch is empty — its only
// purpose is to get CodeMirror to re-call update() so the decorations
// rebuild against fresh awareness state.
const remoteSelectionsRefresh = Annotation.define<true>();

// Only the selection-highlight (Decoration.mark) classes live in the
// baseTheme now. The caret bar + name label used to be a
// Decoration.widget injected INSIDE the contenteditable — that is what
// ghosted on iOS WebView when repositioned. They are now rendered as an
// absolutely-positioned overlay OUTSIDE the text flow (see
// CaretOverlay below + the `.cm-collab-cursor-*` rules in styles.css),
// so there is no contenteditable repaint quirk to fight.
export const yRemoteSelectionsTheme = EditorView.baseTheme({
  ".cm-ySelection": {},
  ".cm-yLineSelection": {
    padding: 0,
    margin: "0px 2px 0px 4px",
  },
});

interface RemoteUser {
  name?: string;
  color?: string;
  colorLight?: string;
}

interface RemoteCursor {
  // JSON form of a Y.RelativePosition — what
  // createRelativePositionFromTypeIndex produces and what awareness
  // serialises across the wire.
  anchor: unknown;
  head: unknown;
}

interface RemoteAwarenessState {
  user?: RemoteUser;
  cursor?: RemoteCursor | null;
}

// One peer's caret, resolved to an absolute char offset in OUR doc plus
// presentation. Produced by build(); consumed by CaretOverlay to place
// (or hide) the DOM element for that peer this frame.
interface PeerCaret {
  clientId: number;
  headPos: number;
  color: string;
  name: string;
}

// ─── Caret overlay ────────────────────────────────────────────────────
//
// Remote carets (the thin vertical bar) and name labels are rendered as
// an absolutely-positioned overlay appended to the editor's scroller
// (`view.scrollDOM`), NOT as CodeMirror widgets inside the
// contenteditable. This is the whole fix for the iOS WebView ghost-caret
// bug: when caret/label DOM lives inside the contenteditable and is
// removed/repositioned as a peer moves, iOS leaves stale painted pixels
// behind. An overlay outside the text flow has none of that — same
// approach proven solid by canvas-cursors.ts.
//
// Coordinate space. The overlay container is
// `position:absolute; top/left:0` inside `view.scrollDOM`, which is the
// scroll *container* (its own bounding box does not move when content
// scrolls; only its scrollTop/scrollLeft change). We position each caret
// with `view.coordsAtPos(pos)`, which returns viewport (client) rects.
// To convert a client rect into a coordinate inside scrollDOM's content
// box we do:
//
//     localX = clientX - scrollDOM.clientLeft - scrollRect.left + scrollLeft
//     localY = clientY - scrollDOM.clientTop  - scrollRect.top  + scrollTop
//
// Because the offset is anchored to the *content* (we add scrollLeft/
// scrollTop), the caret stays glued to its character as the user
// scrolls. CodeMirror calls our plugin update() on viewportChanged /
// geometryChanged during scroll, which re-runs reposition(); a scroll
// listener on scrollDOM is added as a belt-and-suspenders for momentum
// scrolling where update() may lag a frame.
class CaretOverlay {
  private readonly view: EditorView;
  private readonly container: HTMLDivElement;
  private readonly els = new Map<number, HTMLDivElement>();
  private readonly onScroll: () => void;
  // Last computed carets, kept so the scroll listener can reposition
  // without rebuilding from awareness.
  private carets: PeerCaret[] = [];

  constructor(view: EditorView) {
    this.view = view;
    this.container = document.createElement("div");
    this.container.className = "cm-collab-cursor-overlay";
    view.scrollDOM.appendChild(this.container);
    this.onScroll = () => this.reposition();
    // passive: we never preventDefault; just reposition.
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
  }

  // Replace the set of peers and immediately lay them out.
  setCarets(carets: PeerCaret[]): void {
    this.carets = carets;
    const seen = new Set<number>();
    for (const c of carets) {
      seen.add(c.clientId);
      let el = this.els.get(c.clientId);
      if (!el) {
        el = this.createEl();
        this.els.set(c.clientId, el);
        this.container.appendChild(el);
      }
      el.style.color = c.color;
      const bar = el.firstElementChild as HTMLElement | null;
      if (bar) bar.style.backgroundColor = c.color;
      const label = el.lastElementChild as HTMLElement | null;
      if (label) {
        if (label.textContent !== c.name) label.textContent = c.name;
        label.style.backgroundColor = c.color;
      }
    }
    // GC peers no longer present (left, cursor null, or not in our ytext).
    for (const [id, el] of this.els) {
      if (!seen.has(id)) {
        el.remove();
        this.els.delete(id);
      }
    }
    this.reposition();
  }

  // Re-place every tracked caret against the current layout. Cheap; no
  // awareness reads. Hides any caret whose position is not currently
  // rendered (coordsAtPos returns null when folded / outside viewport).
  reposition(): void {
    if (this.carets.length === 0) return;
    const scrollRect = this.view.scrollDOM.getBoundingClientRect();
    const scrollLeft = this.view.scrollDOM.scrollLeft;
    const scrollTop = this.view.scrollDOM.scrollTop;
    const clientLeft = this.view.scrollDOM.clientLeft;
    const clientTop = this.view.scrollDOM.clientTop;
    for (const c of this.carets) {
      const el = this.els.get(c.clientId);
      if (!el) continue;
      let coords: { left: number; right: number; top: number; bottom: number } | null =
        null;
      try {
        coords = this.view.coordsAtPos(c.headPos);
      } catch {
        coords = null;
      }
      if (!coords) {
        // Scrolled out of view / folded / not rendered — hide rather
        // than draw at a bogus position.
        el.style.display = "none";
        continue;
      }
      const x = coords.left - clientLeft - scrollRect.left + scrollLeft;
      const y = coords.top - clientTop - scrollRect.top + scrollTop;
      const height = coords.bottom - coords.top;
      el.style.display = "";
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.height = `${height}px`;
    }
  }

  private createEl(): HTMLDivElement {
    const el = document.createElement("div");
    el.className = "cm-collab-cursor";
    const bar = document.createElement("div");
    bar.className = "cm-collab-cursor-bar";
    el.appendChild(bar);
    const label = document.createElement("div");
    label.className = "cm-collab-cursor-label";
    el.appendChild(label);
    return el;
  }

  // Hide all carets without tearing down the elements — used when the
  // collab context goes inactive/null. setCarets([]) on the next active
  // build will GC them.
  clear(): void {
    this.carets = [];
    for (const [id, el] of this.els) {
      el.remove();
      this.els.delete(id);
    }
  }

  destroy(): void {
    this.clear();
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.container.remove();
  }
}

class YRemoteSelectionsPluginValue {
  private readonly view: EditorView;
  private readonly resolve: ResolveContext;
  decorations: DecorationSet;
  // The awareness we're currently SUBSCRIBED to. Tracked separately
  // from the resolved context so we can swap subscriptions on rebind.
  private boundAwareness: Awareness | null = null;
  private boundDocId: string | null = null;
  private listener:
    | ((event: {
        added: number[];
        updated: number[];
        removed: number[];
      }) => void)
    | null = null;
  // Coalesce 'change' events fired in rapid succession into a single
  // dispatch. CodeMirror forbids re-entrant dispatches; even if it
  // didn't, we'd queue an avalanche of redraws otherwise.
  private dispatchPending = false;
  // Overlay for remote carets + labels, lives OUTSIDE the
  // contenteditable (see CaretOverlay). Created per-EditorView.
  private readonly overlay: CaretOverlay;

  constructor(view: EditorView) {
    this.view = view;
    this.resolve = view.state.facet(resolveContextFacet);
    this.decorations = RangeSet.of([]);
    this.overlay = new CaretOverlay(view);
    // First subscribe happens lazily on the first update() so we don't
    // dispatch from inside CodeMirror's plugin construction.
  }

  // Subscribe to the active awareness's 'change' event. Idempotent —
  // only changes the subscription when the awareness identity changes.
  private rebindAwareness(awareness: Awareness | null, docId: string | null) {
    if (this.boundAwareness === awareness && this.boundDocId === docId) return;
    if (this.listener && this.boundAwareness) {
      try {
        this.boundAwareness.off("change", this.listener);
      } catch {
        /* ignore */
      }
    }
    this.boundAwareness = awareness;
    this.boundDocId = docId;
    this.listener = null;
    if (!awareness) return;

    const local = awareness.clientID;
    this.listener = ({ added, updated, removed }) => {
      const hasRemote =
        added.some((id) => id !== local) ||
        updated.some((id) => id !== local) ||
        removed.some((id) => id !== local);
      if (!hasRemote) return;
      if (this.dispatchPending) return;
      this.dispatchPending = true;
      setTimeout(() => {
        this.dispatchPending = false;
        if (!this.view.dom.isConnected) return;
        try {
          this.view.dispatch({
            annotations: [remoteSelectionsRefresh.of(true)],
          });
        } catch {
          /* ignore */
        }
      }, 0);
    };
    awareness.on("change", this.listener);
  }

  update(update: ViewUpdate): void {
    const ctx = this.resolve(this.view);
    if (!ctx || !ctx.active) {
      // Released — drop any existing subscription, decorations and
      // overlay carets.
      this.rebindAwareness(null, null);
      if (this.decorations.size > 0) {
        this.decorations = RangeSet.of([]);
      }
      this.overlay.clear();
      return;
    }

    // Ensure subscription matches the current context.
    this.rebindAwareness(ctx.awareness, ctx.docId);

    // Publish OUR cursor on selection / focus / doc changes. The `user`
    // field is owned by LocalPresenceController; this normally writes
    // only the cursor coordinate, but falls back to a full
    // { user, cursor } write if the local awareness state is null (so we
    // never advertise a cursor with no identity, and never no-op on a
    // null state).
    this.publishLocalCursor(update, ctx.ytext, ctx.awareness, ctx.user);

    // Rebuild decorations (selection-highlight marks) AND collect the
    // remote carets, which go to the overlay rather than into the doc.
    const carets: PeerCaret[] = [];
    this.decorations = this.build(ctx.ytext, ctx.awareness, carets);
    this.overlay.setCarets(carets);

    // Reposition the overlay carets whenever layout could have moved
    // them: typing/doc edits, scroll (viewport), resize/layout
    // (geometry), or selection. setCarets() above already repositioned
    // for the awareness-driven rebuild; this covers the cases where the
    // awareness state is unchanged but the geometry isn't.
    if (
      update.docChanged ||
      update.viewportChanged ||
      update.geometryChanged ||
      update.selectionSet
    ) {
      this.overlay.reposition();
    }
  }

  private publishLocalCursor(
    update: ViewUpdate,
    ytext: Y.Text,
    awareness: Awareness,
    user: { name: string; color: string },
  ): void {
    if (
      !update.selectionSet &&
      !update.docChanged &&
      !update.focusChanged &&
      this.boundDocId !== null /* no init pulse needed if not first time */
    ) {
      return;
    }
    const view = update.view;
    const hasFocus = view.hasFocus && view.dom.ownerDocument.hasFocus();
    const local = awareness.getLocalState() as RemoteAwarenessState | null;
    const sel = hasFocus ? update.state.selection.main : null;

    if (sel != null) {
      const currentAnchor =
        local?.cursor == null
          ? null
          : Y.createRelativePositionFromJSON(local.cursor.anchor);
      const currentHead =
        local?.cursor == null
          ? null
          : Y.createRelativePositionFromJSON(local.cursor.head);
      const anchor = Y.createRelativePositionFromTypeIndex(ytext, sel.anchor);
      const head = Y.createRelativePositionFromTypeIndex(ytext, sel.head);
      if (
        local == null ||
        local.cursor == null ||
        !Y.compareRelativePositions(currentAnchor, anchor) ||
        !Y.compareRelativePositions(currentHead, head)
      ) {
        this.writeCursor(awareness, local, user, { anchor, head });
      }
    } else if (hasFocus && (local == null || local.cursor != null)) {
      // Focused but no live selection to advertise (e.g. editor focused
      // with caret not yet placed, or selection cleared). Clear our
      // cursor — but if local state is null, still establish identity so
      // peers don't see us as gone. We only do this when local is null
      // OR a cursor was previously set, to avoid pointless rewrites.
      this.writeCursor(awareness, local, user, null);
    }
  }

  // Null-safe cursor write. y-protocols' setLocalStateField is a no-op
  // when the local state object is null (it has nothing to add a field
  // to). That null window is real: presence's broadcastAll may not have
  // run yet for a freshly-bound session when the editor first publishes
  // a cursor. In that window we must write the FULL { user, cursor }
  // object via setLocalState, using the identity threaded through the
  // context, so the peer never advertises a cursor with no name — or,
  // worse, advertises nothing at all. Once a state object exists, we
  // update just the cursor field and leave presence's `user` untouched.
  private writeCursor(
    awareness: Awareness,
    local: RemoteAwarenessState | null,
    user: { name: string; color: string },
    cursor: RemoteCursor | null,
  ): void {
    try {
      if (local == null) {
        awareness.setLocalState({ user, cursor } as unknown as Record<
          string,
          unknown
        >);
      } else {
        awareness.setLocalStateField("cursor", cursor);
      }
    } catch (err) {
      console.warn("[yedit] publish cursor failed", err);
    }
  }

  private build(
    ytext: Y.Text,
    awareness: Awareness,
    carets: PeerCaret[],
  ): DecorationSet {
    const ydoc = ytext.doc;
    if (!ydoc) return RangeSet.of([]);
    const local = awareness.clientID;
    const docLen = this.view.state.doc.length;
    const decorations: Range<Decoration>[] = [];

    awareness.getStates().forEach((rawState, clientId) => {
      try {
        this.buildOnePeer(
          rawState,
          clientId,
          local,
          ytext,
          docLen,
          decorations,
          carets,
        );
      } catch (err) {
        // One bad peer state must not crash the entire decoration
        // build — that would freeze every other peer's cursor on
        // screen (visible as ghost cursors / lingering CSS especially
        // on mobile WebView). Log and continue.
        console.warn("[collab] buildOnePeer threw", clientId, err);
      }
    });

    // Sorting in Decoration.set(..., true) requires consistent order;
    // any inconsistencies would also throw the same way. Defensive.
    try {
      return Decoration.set(decorations, true);
    } catch (err) {
      console.warn("[collab] Decoration.set threw on build, returning empty set", err);
      return Decoration.set([], true);
    }
  }

  private buildOnePeer(
    rawState: unknown,
    clientId: number,
    local: number,
    ytext: Y.Text,
    docLen: number,
    decorations: Range<Decoration>[],
    carets: PeerCaret[],
  ): void {
    const ydoc = ytext.doc;
    if (!ydoc) return;
    if (clientId === local) return;
    const state = rawState as RemoteAwarenessState;
    const cursor = state.cursor;
    if (!cursor || cursor.anchor == null || cursor.head == null) return;

      let anchor: ReturnType<
        typeof Y.createAbsolutePositionFromRelativePosition
      > = null;
      let head: ReturnType<
        typeof Y.createAbsolutePositionFromRelativePosition
      > = null;
      try {
        anchor = Y.createAbsolutePositionFromRelativePosition(
          cursor.anchor as Y.RelativePosition,
          ydoc,
        );
        head = Y.createAbsolutePositionFromRelativePosition(
          cursor.head as Y.RelativePosition,
          ydoc,
        );
      } catch {
        return;
      }
      if (!anchor || !head) return;
      // Cursor refers to a different Y.Text than the one we're bound
      // to — not for this editor.
      if (anchor.type !== ytext || head.type !== ytext) return;

      const aPos = clamp(anchor.index, 0, docLen);
      const hPos = clamp(head.index, 0, docLen);
      // If positions clamp into the doc but they were out-of-range
      // (peer's cursor is past the end of our local copy), skip drawing
      // a caret — better to render nothing than a misleading position.
      if (anchor.index > docLen || head.index > docLen) {
        return;
      }

      const user = state.user;
      const color = user?.color ?? "#30bced";
      const name = user?.name ?? "anonymous";
      const colorLight = user?.colorLight ?? color + "33";

      const start = Math.min(aPos, hPos);
      const end = Math.max(aPos, hPos);
      const startLine = this.view.state.doc.lineAt(start);
      const endLine = this.view.state.doc.lineAt(end);

      if (start !== end) {
        if (startLine.number === endLine.number) {
          decorations.push(
            Decoration.mark({
              attributes: { style: `background-color: ${colorLight}` },
              class: "cm-ySelection",
            }).range(start, end),
          );
        } else {
          // Multi-line selection. The first-line mark goes from `start`
          // to end-of-line; the last-line mark goes from start-of-line
          // to `end`. CodeMirror throws "Mark decorations may not be
          // empty" if either pair coincides — happens when the peer's
          // selection starts exactly at end-of-line (start === EOL) or
          // ends exactly at start-of-line (end === BOL). Guard both,
          // otherwise the throw aborts the whole decoration build and
          // every peer's cursor freezes on screen until the next clean
          // build (visible CSS leftovers on mobile especially).
          const startLineEnd = startLine.from + startLine.length;
          if (start !== startLineEnd) {
            decorations.push(
              Decoration.mark({
                attributes: { style: `background-color: ${colorLight}` },
                class: "cm-ySelection",
              }).range(start, startLineEnd),
            );
          }
          if (endLine.from !== end) {
            decorations.push(
              Decoration.mark({
                attributes: { style: `background-color: ${colorLight}` },
                class: "cm-ySelection",
              }).range(endLine.from, end),
            );
          }
          for (let i = startLine.number + 1; i < endLine.number; i++) {
            const linePos = this.view.state.doc.line(i).from;
            decorations.push(
              Decoration.line({
                attributes: {
                  style: `background-color: ${colorLight}`,
                  class: "cm-yLineSelection",
                },
              }).range(linePos),
            );
          }
        }
      }

    // The caret bar + name label are NOT a decoration. They go to the
    // overlay (CaretOverlay) which positions them via coordsAtPos
    // outside the contenteditable, dodging the iOS ghost-paint bug.
    carets.push({ clientId, headPos: hPos, color, name });
  }

  destroy(): void {
    if (this.listener && this.boundAwareness) {
      try {
        this.boundAwareness.off("change", this.listener);
      } catch {
        /* ignore */
      }
    }
    this.listener = null;
    this.boundAwareness = null;
    this.boundDocId = null;
    this.decorations = RangeSet.of([]);
    this.overlay.destroy();
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

export const yRemoteSelections: Extension = ViewPlugin.fromClass(
  YRemoteSelectionsPluginValue,
  {
    decorations: (v) => v.decorations,
  },
);
