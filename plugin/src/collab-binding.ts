// SPDX-License-Identifier: AGPL-3.0-only
//
// Bidirectional editor ↔ Y.Text binding written from scratch.
//
// We previously used `y-codemirror.next`'s `yCollab` extension. It works
// fine when one editor is bound to one file for life, but Obsidian
// reuses the SAME EditorView across every file in a pane — `yCollab`'s
// `ySync` and `yRemoteSelections` are module-level `ViewPlugin`
// constants, so CodeMirror identifies them by reference, reuses the old
// instance when we reconfigure the compartment for a new file, and the
// instance's constructor-cached `this.conf` keeps pointing at the
// previous file's Y.Text / Awareness. Result: edits in file B were
// forwarded into file A's CRDT, remote cursors landed on the wrong
// editor, awareness froze.
//
// In this module every call to `createCollabBinding(...)` produces
// FRESH `ViewPlugin.fromClass(...)` instances. Their identity is
// per-call, so the next `compartment.reconfigure(...)` is a real
// destroy-and-recreate — the old observers are unhooked, the new ones
// observe the right Y.Text + Awareness.

import {
  Annotation,
  type ChangeSpec,
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

// Annotation attached to every transaction we dispatch into the editor
// from a Y.Text-side change (the remote observer or the host's initial
// sync). The sync plugin's `update` method checks this annotation and
// refuses to forward such transactions back into Y.Text — that's the
// loop breaker.
export const COLLAB_SYNC = Annotation.define<true>();

interface AwarenessUser {
  name?: string;
  color?: string;
}

interface AwarenessCursor {
  // Stored as the JSON form of Y.RelativePosition (what
  // createRelativePositionFromTypeIndex produces and what
  // Awareness serialises across the wire).
  anchor: object;
  head: object;
}

interface AwarenessState {
  user?: AwarenessUser;
  cursor?: AwarenessCursor;
}

export function createCollabBinding(
  ytext: Y.Text,
  awareness: Awareness,
): Extension {
  // ── editor ↔ Y.Text ─────────────────────────────────────────────────
  const syncPlugin = ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      private readonly observer: (
        event: Y.YTextEvent,
        tr: Y.Transaction,
      ) => void;

      constructor(view: EditorView) {
        this.view = view;

        // Y.Text → editor
        this.observer = (event, tr) => {
          // Skip events from transactions we ourselves initiated when
          // forwarding editor edits, otherwise we'd echo them back.
          if (tr.origin === this) return;

          const changes: ChangeSpec[] = [];
          let pos = 0;
          for (const op of event.delta) {
            if (op.retain != null) {
              pos += op.retain;
            } else if (op.insert != null) {
              const insert =
                typeof op.insert === "string" ? op.insert : "";
              changes.push({ from: pos, to: pos, insert });
              pos += insert.length;
            } else if (op.delete != null) {
              changes.push({
                from: pos,
                to: pos + op.delete,
                insert: "",
              });
            }
          }
          if (changes.length === 0) return;

          // Apply the delta. If the editor and ytext have drifted out
          // of sync (e.g. an offline-merge brought in a delta whose
          // positions reference content the editor hasn't received
          // yet, or a previous dispatch failed), CodeMirror throws
          // "Invalid change range". When that happens we MUST resync,
          // not silently leave the two sides diverged — divergence is
          // the trigger for the exponential doubling loop: each
          // subsequent successful delta gets re-pushed by the editor
          // as a "fresh user edit" and ytext grows uncontrollably.
          //
          // Resync strategy: replace the entire editor doc with the
          // current ytext content, in a single dispatch carrying the
          // COLLAB_SYNC annotation so the editor→Y.Text path doesn't
          // try to echo this huge replacement back into ytext.
          try {
            view.dispatch({
              changes,
              annotations: [COLLAB_SYNC.of(true)],
            });
          } catch (err) {
            console.warn(
              "[collab] editor dispatch failed, force-resyncing editor to ytext",
              err,
            );
            try {
              const ytextStr = ytext.toString();
              const docLen = view.state.doc.length;
              view.dispatch({
                changes: { from: 0, to: docLen, insert: ytextStr },
                annotations: [COLLAB_SYNC.of(true)],
              });
            } catch (err2) {
              console.error(
                "[collab] force-resync ALSO failed; editor/ytext now permanently diverged for this session",
                err2,
              );
            }
          }
        };
        ytext.observe(this.observer);
      }

      // editor → Y.Text
      update(update: ViewUpdate) {
        for (const tr of update.transactions) {
          // Skip transactions we (or the host's initial-sync code)
          // dispatched ourselves — they originated on the Y.Text side
          // already.
          if (tr.annotation(COLLAB_SYNC)) continue;
          if (tr.changes.empty) continue;

          ytext.doc?.transact(() => {
            tr.changes.iterChanges(
              (fromA, toA, _fromB, _toB, inserted) => {
                const insertText = inserted.sliceString(
                  0,
                  inserted.length,
                  "\n",
                );
                if (fromA !== toA) {
                  ytext.delete(fromA, toA - fromA);
                }
                if (insertText.length > 0) {
                  ytext.insert(fromA, insertText);
                }
              },
            );
          }, this);
        }

        // Publish current selection to awareness so peers can render
        // our caret + selection. We only do this while the editor has
        // focus — otherwise switching to another file would leave our
        // last position broadcasting forever.
        const hasFocus = update.view.hasFocus;
        if (
          hasFocus &&
          (update.selectionSet || update.docChanged || update.focusChanged)
        ) {
          const sel = update.state.selection.main;
          const anchor = Y.createRelativePositionFromTypeIndex(
            ytext,
            sel.anchor,
          );
          const head = Y.createRelativePositionFromTypeIndex(
            ytext,
            sel.head,
          );
          awareness.setLocalStateField("cursor", { anchor, head });
        } else if (!hasFocus && update.focusChanged) {
          // Lost focus — drop the cursor so peers stop seeing it
          // stationary. The "user" field on our awareness state stays
          // (set by the host plugin) so they still know who we are if
          // we move back.
          awareness.setLocalStateField("cursor", null);
        }
      }

      destroy() {
        ytext.unobserve(this.observer);
      }
    },
  );

  // ── remote cursors + selections ─────────────────────────────────────
  const decorationsPlugin = ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      decorations: DecorationSet;
      private readonly listener: (event: {
        added: number[];
        updated: number[];
        removed: number[];
      }) => void;
      private pending = false;

      constructor(view: EditorView) {
        this.view = view;
        this.decorations = this.build();

        const localId = awareness.clientID;
        this.listener = ({ added, updated, removed }) => {
          // Ignore self-only changes — our own cursor never renders on
          // our editor (we filter it out in build()), so no point
          // re-running.
          const hasRemote =
            added.some((id) => id !== localId) ||
            updated.some((id) => id !== localId) ||
            removed.some((id) => id !== localId);
          if (!hasRemote) return;

          // Defer the dispatch. The 'change' event often fires
          // *inside* CodeMirror's own update cycle (e.g. when our
          // sync plugin updates the local cursor field on a typing
          // transaction). CodeMirror forbids re-entering dispatch
          // from within an update; setTimeout puts us outside that
          // call stack. Coalesce concurrent events with a flag so we
          // don't queue an avalanche of dispatches.
          if (this.pending) return;
          this.pending = true;
          setTimeout(() => {
            this.pending = false;
            if (!view.dom.isConnected) return;
            view.dispatch({
              annotations: [COLLAB_SYNC.of(true)],
            });
          }, 0);
        };
        awareness.on("change", this.listener);
      }

      update(_update: ViewUpdate) {
        this.decorations = this.build();
      }

      private build(): DecorationSet {
        const ydoc = ytext.doc;
        if (!ydoc) return Decoration.set([]);
        const localId = awareness.clientID;
        const docLen = this.view.state.doc.length;
        const ranges: Range<Decoration>[] = [];

        awareness.getStates().forEach((stateRaw, clientId) => {
          if (clientId === localId) return;
          const state = stateRaw as AwarenessState;
          const cursor = state.cursor;
          const user = state.user;
          if (!cursor || !cursor.anchor || !cursor.head) return;

          const anchor = Y.createAbsolutePositionFromRelativePosition(
            cursor.anchor as Y.RelativePosition,
            ydoc,
          );
          const head = Y.createAbsolutePositionFromRelativePosition(
            cursor.head as Y.RelativePosition,
            ydoc,
          );
          if (!anchor || !head) return;
          // Cursor refers to a different Y.Text — not for us.
          if (anchor.type !== ytext || head.type !== ytext) return;

          const aPos = clamp(anchor.index, 0, docLen);
          const hPos = clamp(head.index, 0, docLen);
          const color = user?.color ?? "#888";
          const name = user?.name ?? "anonymous";

          // Selection highlight, if there is a real range.
          if (aPos !== hPos) {
            const from = Math.min(aPos, hPos);
            const to = Math.max(aPos, hPos);
            ranges.push(
              Decoration.mark({
                attributes: {
                  style: `background-color: ${rgbaFromHex(color, 0.25)};`,
                  class: "cm-ySelection",
                },
              }).range(from, to),
            );
          }

          // Caret widget at the head position.
          ranges.push(
            Decoration.widget({
              widget: new RemoteCaretWidget(color, name),
              side: hPos > aPos ? -1 : 1,
            }).range(hPos),
          );
        });

        return Decoration.set(ranges, true);
      }

      destroy() {
        awareness.off("change", this.listener);
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );

  return [syncPlugin, decorationsPlugin];
}

// ── helpers ──────────────────────────────────────────────────────────

class RemoteCaretWidget extends WidgetType {
  constructor(
    private readonly color: string,
    private readonly name: string,
  ) {
    super();
  }

  toDOM() {
    // The DOM structure mirrors what y-codemirror.next produced so our
    // existing styles.css (which targets cm-ySelectionCaret /
    // cm-ySelectionCaretDot / cm-ySelectionInfo to make the name label
    // always visible) keeps working untouched.
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

  eq(other: RemoteCaretWidget) {
    return this.color === other.color && this.name === other.name;
  }

  updateDOM() {
    return false;
  }

  get estimatedHeight() {
    return -1;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function rgbaFromHex(color: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return `rgba(136,136,136,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
