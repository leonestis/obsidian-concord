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
  WidgetType,
} from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { resolveContextFacet, type ResolveContext } from "./y-sync";

// Annotation we use to trigger an editor dispatch when awareness fires
// outside the normal update flow. The dispatch is empty — its only
// purpose is to get CodeMirror to re-call update() so the decorations
// rebuild against fresh awareness state.
const remoteSelectionsRefresh = Annotation.define<true>();

export const yRemoteSelectionsTheme = EditorView.baseTheme({
  ".cm-ySelection": {},
  ".cm-yLineSelection": {
    padding: 0,
    margin: "0px 2px 0px 4px",
  },
  ".cm-ySelectionCaret": {
    position: "relative",
    borderLeft: "1px solid black",
    borderRight: "1px solid black",
    marginLeft: "-1px",
    marginRight: "-1px",
    boxSizing: "border-box",
    display: "inline",
  },
  ".cm-ySelectionCaretDot": {
    borderRadius: "50%",
    position: "absolute",
    width: ".4em",
    height: ".4em",
    top: "-.2em",
    left: "-.2em",
    backgroundColor: "inherit",
    transition: "transform .3s ease-in-out",
    boxSizing: "border-box",
  },
  ".cm-ySelectionCaret:hover > .cm-ySelectionCaretDot": {
    transformOrigin: "bottom center",
    transform: "scale(0)",
  },
  ".cm-ySelectionInfo": {
    position: "absolute",
    top: "-1.05em",
    left: "-1px",
    fontSize: ".75em",
    fontFamily: "serif",
    fontStyle: "normal",
    fontWeight: "normal",
    lineHeight: "normal",
    userSelect: "none",
    color: "white",
    paddingLeft: "2px",
    paddingRight: "2px",
    zIndex: 101,
    transition: "opacity .3s ease-in-out",
    backgroundColor: "inherit",
    opacity: 0,
    transitionDelay: "0s",
    whiteSpace: "nowrap",
  },
  ".cm-ySelectionCaret:hover > .cm-ySelectionInfo": {
    opacity: 1,
    transitionDelay: "0s",
  },
});

class YRemoteCaretWidget extends WidgetType {
  constructor(
    private readonly color: string,
    private readonly name: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ySelectionCaret";
    span.style.backgroundColor = this.color;
    span.style.borderColor = this.color;
    span.append(document.createTextNode("⁠"));
    const dot = document.createElement("div");
    dot.className = "cm-ySelectionCaretDot";
    span.append(dot);
    span.append(document.createTextNode("⁠"));
    const info = document.createElement("div");
    info.className = "cm-ySelectionInfo";
    info.textContent = this.name;
    span.append(info);
    span.append(document.createTextNode("⁠"));
    return span;
  }

  eq(_other: YRemoteCaretWidget): boolean {
    // Always return false so CodeMirror tears down the old widget DOM
    // and creates a fresh one on every decoration update. The "natural"
    // implementation here would compare color + name and return true
    // (same identity → reuse DOM, just reposition). On desktop that
    // works fine. On iOS WebView (and to a lesser extent Android
    // WebView) the reposition of an absolutely-positioned label
    // inside a transformed parent leaves rendering ghosts — the old
    // label stays painted at the previous position while the parent
    // moves. Forcing recreate eliminates the issue entirely. The cost
    // is a few extra DOM operations per peer-cursor move, which is
    // imperceptible compared to the ghosting artefact.
    return false;
  }

  updateDOM(): boolean {
    // Pair with eq() returning false: tell CodeMirror our widget can't
    // be in-place updated, always recreate via toDOM().
    return false;
  }

  get estimatedHeight(): number {
    return -1;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

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

  constructor(view: EditorView) {
    this.view = view;
    this.resolve = view.state.facet(resolveContextFacet);
    this.decorations = RangeSet.of([]);
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
      // Released — drop any existing subscription and decorations.
      this.rebindAwareness(null, null);
      if (this.decorations.size > 0) {
        this.decorations = RangeSet.of([]);
      }
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

    // Rebuild decorations against the current awareness state.
    this.decorations = this.build(ctx.ytext, ctx.awareness);
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

  private build(ytext: Y.Text, awareness: Awareness): DecorationSet {
    const ydoc = ytext.doc;
    if (!ydoc) return RangeSet.of([]);
    const local = awareness.clientID;
    const docLen = this.view.state.doc.length;
    const decorations: Range<Decoration>[] = [];

    awareness.getStates().forEach((rawState, clientId) => {
      try {
        this.buildOnePeer(rawState, clientId, local, ytext, docLen, decorations);
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

    decorations.push(
      Decoration.widget({
        widget: new YRemoteCaretWidget(color, name),
        side: hPos - aPos > 0 ? -1 : 1,
      }).range(hPos),
    );
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
