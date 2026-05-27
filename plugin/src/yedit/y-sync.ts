// SPDX-License-Identifier: MIT
// See LICENSE.upstream (yjs/y-codemirror.next) and LICENSE.relay (No-Instructions/Relay).
//
// Editor ↔ Y.Text binding with DYNAMIC context resolution.
//
// Unlike upstream's `ySync`, the Y.Text and Awareness are NOT captured in
// the constructor. Instead a `resolveContext(view)` function is read out of
// a Facet on every observer callback and on every update() cycle. When the
// context changes (different docId than last time, or null), we
// unobserve / re-observe and reconcile the editor against the new Y.Text.
//
// That's the structural fix for Obsidian's view-recycling problem: the
// same ViewPlugin instance survives file switches and only its internal
// state changes when the user navigates. Compare to the v0.9.x approach
// of minting a fresh ViewPlugin every rebind — which produced a one-tick
// awareness drop on every switch.
//
// This file owns:
//   - editor → Y.Text dispatch (the editor's `update()` cycle).
//   - Y.Text → editor observer (Yjs events translated into ChangeSpec[]).
//   - parity-check defense (editor.length vs ytext.length, force-resync
//     via diff-match-patch on divergence).
//   - removeAwarenessStates on context switch so peers see our cursor
//     in the old file vanish immediately (not after a 30s heartbeat).
//
// It does NOT own:
//   - publishing local user info / cursor (selection changes here just
//     write to `awareness.cursor`; the `user` field is set by
//     LocalPresenceController on focus changes).
//   - decoration rendering (that's y-remote-selections.ts).

import {
  Annotation,
  Facet,
  type ChangeSpec,
  type Extension,
} from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import { removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import diff_match_patch from "diff-match-patch";

// Resolved context: what Y.Text + which Awareness this editor should bind
// to RIGHT NOW. Returned by the host (LiveViewManager) per editor.
//
// `active === false` means "this editor's leaf has been released — keep
// the plugin inert until the manager re-attaches us". A returned `null`
// (or absent path lookup) means the same thing.
//
// `docId` is what we compare against the last-seen value to detect a
// real binding change. Two different files always have different docIds
// (UUIDs minted at create time); a rename keeps the same docId.
export interface YeditContext {
  ytext: Y.Text;
  awareness: Awareness;
  docId: string;
  active: boolean;
}

export type ResolveContext = (view: EditorView) => YeditContext | null;

// Facet the host installs once; the plugins read it on every callback.
// `combine` takes the last input — usual Facet pattern.
export const resolveContextFacet: Facet<ResolveContext, ResolveContext> =
  Facet.define({
    combine(inputs) {
      // If no resolver is configured, return a function that always
      // returns null. The plugins will sit inert.
      return inputs[inputs.length - 1] ?? (() => null);
    },
  });

// Annotation attached to every transaction we dispatch from a Y.Text
// event (or from a reconcile). The update() method ignores these so we
// don't echo Y-originated changes back into ytext.
export const ySyncAnnotation = Annotation.define<true>();

// Internal: collapse two adjacent insert+delete ChangeSpecs into a
// single replace. diff-match-patch emits them separately, but
// CodeMirror is happier with the merged form (preserves selections
// better when an undo is later applied to the same range).
function mergeAdjacentReplaces(changes: ChangeSpec[]): ChangeSpec[] {
  const merged: ChangeSpec[] = [];
  let i = 0;
  while (i < changes.length) {
    const cur = changes[i] as { from: number; to: number; insert: string };
    const next = changes[i + 1] as
      | { from: number; to: number; insert: string }
      | undefined;
    if (
      next &&
      cur.insert === "" &&
      next.from === cur.to &&
      next.to === next.from
    ) {
      merged.push({ from: cur.from, to: cur.to, insert: next.insert });
      i += 2;
    } else {
      merged.push(cur);
      i++;
    }
  }
  return merged;
}

// Turn a "the editor should now contain `newText`" wish into a
// minimal ChangeSpec[] via diff-match-patch. Used on every rebind so we
// don't blow away the user's caret / selection / undo stack with a
// full-document replace.
function bufferDiffToChanges(
  currentBuffer: string,
  newBuffer: string,
): ChangeSpec[] {
  if (currentBuffer === newBuffer) return [];
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(currentBuffer, newBuffer);
  dmp.diff_cleanupSemantic(diffs);

  const changes: ChangeSpec[] = [];
  let pos = 0;
  for (const [type, text] of diffs) {
    if (type === 0) {
      // EQUAL
      pos += text.length;
    } else if (type === 1) {
      // INSERT
      changes.push({ from: pos, to: pos, insert: text });
    } else if (type === -1) {
      // DELETE
      changes.push({ from: pos, to: pos + text.length, insert: "" });
      pos += text.length;
    }
  }
  return mergeAdjacentReplaces(changes);
}

// The ViewPlugin itself. Plugin state machine, in plain prose:
//
//   - constructor() runs once per editor lifetime. Subscribes to nothing
//     yet — first update() will see whatever the facet says and bind.
//   - update() runs on every CodeMirror transaction. Three things happen
//     in order:
//       a) Resolve context. If it changed (different docId, or active
//          flipped, or null), tear down old subscription + re-observe.
//       b) Forward editor changes into ytext (skipping our own
//          Y-annotated transactions).
//       c) Parity check.
//   - The ytext observer runs OUT of the update cycle. It re-resolves
//     context on entry too, in case the plugin was rebinding when the
//     event fired. If context.ytext is no longer the ytext we observed,
//     the observer no-ops — leftover events from a torn-down session.
//   - destroy() unobserves the current ytext and removes our awareness
//     state.
class YSyncPluginValue {
  private readonly view: EditorView;
  private readonly resolve: ResolveContext;
  // What we are CURRENTLY bound to. May lag the facet by one update cycle.
  private boundDocId: string | null = null;
  private boundYtext: Y.Text | null = null;
  private boundAwareness: Awareness | null = null;
  private observer: ((e: Y.YTextEvent, t: Y.Transaction) => void) | null = null;

  constructor(view: EditorView) {
    this.view = view;
    this.resolve = view.state.facet(resolveContextFacet);
    // Bind on the next microtask so we don't dispatch from inside the
    // editor's construction. The first update() will catch us up.
    queueMicrotask(() => {
      if (!view.dom.isConnected) return;
      this.rebindIfNeeded();
    });
  }

  // The actual rebind step. Idempotent — call as often as you like;
  // it only does work when the resolved context differs from what we
  // think we're bound to.
  private rebindIfNeeded(): YeditContext | null {
    const ctx = this.resolve(this.view);

    // Currently bound but should be inert (active=false or no context).
    // Tear down our subscription + awareness state. Don't try to clear
    // editor content — that's not our job (the leaf is being released,
    // not destroyed; user might switch back).
    if (!ctx || !ctx.active) {
      if (this.observer && this.boundYtext) {
        try {
          this.boundYtext.unobserve(this.observer);
        } catch {
          /* ignore */
        }
      }
      if (this.boundAwareness) {
        // Tell peers we left this file. Their RemoteSelections plugin
        // will drop our caret on the next 'change' event.
        try {
          removeAwarenessStates(
            this.boundAwareness,
            [this.boundAwareness.clientID],
            "switch",
          );
        } catch {
          /* ignore */
        }
      }
      this.observer = null;
      this.boundYtext = null;
      this.boundAwareness = null;
      this.boundDocId = null;
      return null;
    }

    // Already bound to the right session — nothing to do.
    if (this.boundDocId === ctx.docId && this.boundYtext === ctx.ytext) {
      return ctx;
    }

    // Real transition: unbind the old, bind the new.
    if (this.observer && this.boundYtext) {
      try {
        this.boundYtext.unobserve(this.observer);
      } catch {
        /* ignore */
      }
    }
    if (this.boundAwareness && this.boundAwareness !== ctx.awareness) {
      try {
        removeAwarenessStates(
          this.boundAwareness,
          [this.boundAwareness.clientID],
          "switch",
        );
      } catch {
        /* ignore */
      }
    }

    // Set the new bound state BEFORE installing the observer so reentrant
    // events have consistent state.
    this.boundDocId = ctx.docId;
    this.boundYtext = ctx.ytext;
    this.boundAwareness = ctx.awareness;

    // Reconcile editor content with the new ytext content. Three cases
    // we care about:
    //
    //   a) editor === ytext  → no-op. The common case for an
    //      already-known file whose binding survived a rename.
    //   b) ytext is empty, editor has content → seed ytext FROM editor.
    //      This is the "first peer on this file" path; without it the
    //      diff would push deletes into the editor and we'd lose the
    //      user's work the moment the binding installed. Phase 3 will
    //      reconcile against disk too; for v2.0.0 we trust the editor
    //      buffer as the source for a fresh-ytext seed.
    //   c) otherwise (both non-empty and differ, or editor empty
    //      ytext non-empty) → push diff INTO editor. Caret + undo
    //      stack survive because we use diff-match-patch, not a full
    //      replace. Phase 3 will replace this with DiskBuffer-mediated
    //      3-way merge; for v2.0.0 this matches the v0.9.2 "ytext wins"
    //      behaviour but without the false-positive .conflict-*.md
    //      files v1.x created.
    try {
      const editorStr = this.view.state.doc.toString();
      const ytextStr = ctx.ytext.toString();
      if (editorStr === ytextStr) {
        // case (a) — nothing to do.
      } else if (ctx.ytext.length === 0 && editorStr.length > 0) {
        // case (b) — seed ytext from editor. Single-insert transaction
        // origin'd by us so our own observer doesn't echo it back into
        // the editor.
        const ytext = ctx.ytext;
        const doc = ytext.doc;
        if (doc) {
          doc.transact(() => {
            ytext.insert(0, editorStr);
          }, this);
          console.log(
            `[yedit] seeded ytext from editor (${editorStr.length} chars) on first bind`,
          );
        }
      } else {
        // case (c) — push diff into editor.
        const changes = bufferDiffToChanges(editorStr, ytextStr);
        if (changes.length > 0) {
          this.view.dispatch({
            changes,
            annotations: [ySyncAnnotation.of(true)],
          });
        }
      }
    } catch (err) {
      // If the diff dispatch fails, fall back to a full-document
      // replace — losing caret position is better than diverging
      // forever.
      try {
        const ytextStr = ctx.ytext.toString();
        const docLen = this.view.state.doc.length;
        this.view.dispatch({
          changes: { from: 0, to: docLen, insert: ytextStr },
          annotations: [ySyncAnnotation.of(true)],
        });
      } catch {
        /* truly hopeless; parity check will retry */
      }
      console.warn("[yedit] reconcile diff failed, full-replace fallback", err);
    }

    // Install the Y.Text observer. Translates Y events into editor
    // ChangeSpec[]. Defensive against torn-down sessions.
    this.observer = (event, tr) => {
      // Skip echoes of changes we initiated ourselves.
      if (tr.origin === this) return;
      // If the bound state shifted between this event scheduling and
      // its delivery, bail. Stale Y events from a tear-down can fire
      // for a tick or two after unobserve().
      if (this.boundYtext !== event.target) return;
      if (!this.view.dom.isConnected) return;

      const changes: ChangeSpec[] = [];
      let pos = 0;
      for (const op of event.delta) {
        if (op.retain != null) {
          pos += op.retain;
        } else if (op.insert != null) {
          const insert = typeof op.insert === "string" ? op.insert : "";
          changes.push({ from: pos, to: pos, insert });
          pos += insert.length;
        } else if (op.delete != null) {
          changes.push({ from: pos, to: pos + op.delete, insert: "" });
        }
      }
      if (changes.length === 0) return;

      try {
        this.view.dispatch({
          changes,
          annotations: [ySyncAnnotation.of(true)],
        });
      } catch (err) {
        // The delta refers to positions outside the editor's current
        // document — the two sides have drifted. Force-resync to
        // ytext's current string. parityCheck will catch it on the
        // next update too, but doing it here removes a one-tick window
        // where the editor would be diverged.
        console.warn(
          "[yedit] observer dispatch failed, force-resyncing editor to ytext",
          err,
        );
        try {
          const ytextStr = this.boundYtext?.toString() ?? "";
          this.view.dispatch({
            changes: {
              from: 0,
              to: this.view.state.doc.length,
              insert: ytextStr,
            },
            annotations: [ySyncAnnotation.of(true)],
          });
        } catch (err2) {
          console.error("[yedit] force-resync also failed", err2);
        }
      }
    };
    ctx.ytext.observe(this.observer);

    return ctx;
  }

  // Forward editor changes into ytext. Skips our own Y-annotated
  // transactions (the loop breaker).
  update(update: ViewUpdate): void {
    const ctx = this.rebindIfNeeded();
    if (!ctx || !ctx.active) return;

    if (!update.docChanged) {
      this.parityCheck(update);
      return;
    }

    // Are any of these transactions our own ytext→editor dispatches?
    // If ALL of them are, skip the editor→ytext forward (otherwise
    // we'd echo). If any is user-originated, forward normally — the
    // user-originated transaction's changes are real.
    let allFromY = true;
    for (const tr of update.transactions) {
      if (!tr.annotation(ySyncAnnotation)) {
        allFromY = false;
        break;
      }
    }
    if (allFromY) {
      this.parityCheck(update);
      return;
    }

    const ytext = ctx.ytext;
    const ydoc = ytext.doc;
    if (!ydoc) {
      this.parityCheck(update);
      return;
    }

    ydoc.transact(() => {
      let adj = 0;
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const insertText = inserted.sliceString(0, inserted.length, "\n");
        if (fromA !== toA) {
          ytext.delete(fromA + adj, toA - fromA);
        }
        if (insertText.length > 0) {
          ytext.insert(fromA + adj, insertText);
        }
        adj += insertText.length - (toA - fromA);
      });
    }, this);

    this.parityCheck(update);
  }

  // Defense-in-depth. After every editor cycle the editor's doc length
  // MUST equal ytext.length. If they diverge — a stale delta, a
  // misbehaving peer, a future bug in our forward path — we force-
  // resync via a diff dispatch on the NEXT tick (can't dispatch from
  // inside the update cycle, CodeMirror forbids re-entry).
  private divergenceLogged = false;
  private parityCheck(update: ViewUpdate): void {
    if (!this.boundYtext) return;
    const editorLen = update.state.doc.length;
    const ytextLen = this.boundYtext.length;
    if (editorLen === ytextLen) {
      this.divergenceLogged = false;
      return;
    }
    if (!this.divergenceLogged) {
      console.warn(
        `[yedit] editor↔ytext parity broken: editor=${editorLen}, ytext=${ytextLen} — scheduling resync`,
      );
      this.divergenceLogged = true;
    }
    const view = update.view;
    const ytext = this.boundYtext;
    setTimeout(() => {
      if (!view.dom.isConnected) return;
      if (!ytext.doc) return; // ytext got destroyed in the meantime
      const editorStr = view.state.doc.toString();
      const ytextStr = ytext.toString();
      if (editorStr === ytextStr) return;
      try {
        const changes = bufferDiffToChanges(editorStr, ytextStr);
        if (changes.length === 0) return;
        view.dispatch({
          changes,
          annotations: [ySyncAnnotation.of(true)],
        });
        console.log(
          `[yedit] parity resync: editor restored to ytext (length=${ytextStr.length})`,
        );
      } catch (err) {
        console.error("[yedit] parity resync dispatch failed", err);
      }
    }, 0);
  }

  destroy(): void {
    if (this.observer && this.boundYtext) {
      try {
        this.boundYtext.unobserve(this.observer);
      } catch {
        /* ignore */
      }
    }
    if (this.boundAwareness) {
      try {
        removeAwarenessStates(
          this.boundAwareness,
          [this.boundAwareness.clientID],
          "destroy",
        );
      } catch {
        /* ignore */
      }
    }
    this.observer = null;
    this.boundYtext = null;
    this.boundAwareness = null;
    this.boundDocId = null;
  }
}

export const ySync: Extension = ViewPlugin.fromClass(YSyncPluginValue);
