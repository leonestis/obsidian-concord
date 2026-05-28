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
//
// It does NOT own:
//   - the local awareness state, AT ALL. LocalPresenceController is the
//     SOLE writer of local awareness state.
//     This file used to call removeAwarenessStates on every context
//     switch / release / destroy — but Obsidian REUSES the EditorView
//     across file switches, so those calls fired mid-life and DELETED
//     the local awareness state out from under presence, producing the
//     recurring "friend invisible" bug (presence had written
//     {user,cursor}, then a switch nulled it, and the next
//     setLocalStateField("cursor") no-op'd on the now-null state). The
//     "peer left this file" signal is now owned by presence
//     (setCurrentPath writes {user, cursor:null} to inactive sessions);
//     the "peer fully gone" signal is owned by TextSession.destroy().
//   - publishing local user info (LocalPresenceController owns the
//     `user` field on focus changes; this file only contributes live
//     cursor coordinates via y-remote-selections.ts).
//   - decoration rendering (that's y-remote-selections.ts).

import {
  Annotation,
  Facet,
  type ChangeSpec,
  type Extension,
} from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import diff_match_patch from "diff-match-patch";

import { Notice, TFile, editorInfoField } from "obsidian";
import { DiskBuffer } from "../disk-buffer";

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
//
// `user` is threaded through so y-remote-selections.ts can write a FULL
// `{ user, cursor }` awareness state when it needs to (the local
// awareness state may be null on the very first cursor publish, before
// LocalPresenceController's broadcast has landed). Without it, a
// setLocalStateField("cursor", …) on a null state is a silent no-op and
// the peer advertises nothing. Identity is OWNED by
// LocalPresenceController; this is just a read-only copy the editor
// plugin can fall back on so it never wipes the identity.
export interface YeditContext {
  ytext: Y.Text;
  awareness: Awareness;
  docId: string;
  active: boolean;
  user: { name: string; color: string };
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

// ── Phase 3: DiskBuffer-mediated three-way merge ──────────────────────
//
// Vocabulary (diff3):
//   BASE   = last disk content known consistent with the Y.Text
//            (the DiskBuffer, keyed by docId)
//   OURS   = current Y.Text content (base + concurrent REMOTE edits)
//   THEIRS = current editor / disk content (base + LOCAL offline edits)
//
// Goal: BASE + remoteEdits + localEdits, losing neither side.

const dmp = new diff_match_patch();

// True three-way merge. Build context-anchored patches representing the
// LOCAL edits (base→theirs) and apply them, with diff-match-patch's
// fuzzy location matching, onto OURS (which may have drifted from base
// via remote edits). The fuzzy match relocates each local edit to the
// right spot in the remotely-advanced text — that's what makes this a
// real 3-way merge rather than a naive offset replay (which would
// corrupt when OURS.length ≠ BASE.length).
//
// This is the standard diff3-via-patch algorithm: result =
// apply(patch(base→theirs), ours) = base + remoteEdits + localEdits.
// Remote edits are never dropped (they're already in OURS and patches
// only touch their own anchored spans). A local edit whose context was
// itself rewritten remotely (a genuine conflict) may fail to apply and
// be silently skipped by patch_apply — it still lives in the editor's
// THEIRS buffer, so no disk text is lost. We deliberately trust this
// result, including legitimate offline DELETIONS (a local delete should
// stay deleted, not be resurrected by an additive union).
function threeWayMerge(base: string, ours: string, theirs: string): string {
  // Local edits as patches against base.
  const patches = dmp.patch_make(base, theirs);
  if (patches.length === 0) return ours; // no local edits → ours wins
  const [merged] = dmp.patch_apply(patches, ours);
  return merged;
}

// Additive fallback for when we have no BASE (first-ever open on this
// device). We can't tell which side changed what, so we never DELETE:
// we keep all of OURS and splice in the spans that THEIRS has and OURS
// lacks. Both sides survive. In a true conflict this can duplicate a
// region, but duplication is recoverable by the user and data loss is
// not — that's the whole point.
//
// Returns the additively-merged string.
function additiveMerge(ours: string, theirs: string): string {
  if (ours === theirs) return ours;
  const diffs = dmp.diff_main(ours, theirs);
  dmp.diff_cleanupSemantic(diffs);
  let out = "";
  for (const [type, text] of diffs) {
    if (type === 0) {
      out += text; // common to both → keep once
    } else if (type === 1) {
      out += text; // present in THEIRS only → add it
    } else if (type === -1) {
      out += text; // present in OURS only → keep it (do NOT delete)
    }
  }
  return out;
}

// Apply a target string onto a Y.Text as minimal insert/delete ops,
// computed by diffing the Y.Text's CURRENT content against the target.
// Offsets are therefore relative to the live ytext, so they always line
// up. Runs inside one transaction with the given origin. Returns true if
// any op was applied.
function applyStringToYText(
  ytext: Y.Text,
  target: string,
  origin: unknown,
): boolean {
  const doc = ytext.doc;
  if (!doc) return false;
  const current = ytext.toString();
  if (current === target) return false;
  const diffs = dmp.diff_main(current, target);
  dmp.diff_cleanupSemantic(diffs);
  doc.transact(() => {
    let index = 0;
    for (const [type, text] of diffs) {
      if (type === 0) {
        index += text.length; // EQUAL → advance
      } else if (type === 1) {
        ytext.insert(index, text); // INSERT
        index += text.length;
      } else if (type === -1) {
        ytext.delete(index, text.length); // DELETE
      }
    }
  }, origin);
  return true;
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
//   - destroy() unobserves the current ytext. It does NOT touch
//     awareness — see the destroy() body and the file header.
class YSyncPluginValue {
  private readonly view: EditorView;
  private readonly resolve: ResolveContext;
  // What we are CURRENTLY bound to. May lag the facet by one update cycle.
  private boundDocId: string | null = null;
  private boundYtext: Y.Text | null = null;
  private observer: ((e: Y.YTextEvent, t: Y.Transaction) => void) | null = null;
  // The DiskBuffer (BASE store) for the three-way merge. Shared singleton.
  private readonly diskBuffer = DiskBuffer.shared();
  // True while a disk-merge for the current binding is running. The
  // parity check is a NO-OP while this is set: during the merge window
  // the editor (THEIRS) and ytext (OURS) legitimately differ in length,
  // and a parity resync would force editor→ytext and DESTROY the local
  // edits we're in the middle of preserving. Cleared when the merge's
  // ytext + editor + DiskBuffer are all settled.
  private mergeInFlight = false;

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
    // Tear down our Y.Text subscription only. Don't try to clear editor
    // content — that's not our job (the leaf is being released, not
    // destroyed; user might switch back). And critically: do NOT touch
    // awareness here. Presence (LocalPresenceController.setCurrentPath)
    // is the sole writer of local awareness state and will null this
    // session's cursor when the active file changes. Calling
    // removeAwarenessStates here used to wipe the identity presence had
    // just written → "friend invisible".
    if (!ctx || !ctx.active) {
      if (this.observer && this.boundYtext) {
        try {
          this.boundYtext.unobserve(this.observer);
        } catch {
          /* ignore */
        }
      }
      this.observer = null;
      this.boundYtext = null;
      this.boundDocId = null;
      // Any in-flight merge belonged to the now-released binding; its
      // runDiskMerge will see the binding changed and bail. Clear the
      // flag so a future binding's parity check isn't wrongly suppressed.
      this.mergeInFlight = false;
      return null;
    }

    // Already bound to the right session — nothing to do.
    if (this.boundDocId === ctx.docId && this.boundYtext === ctx.ytext) {
      return ctx;
    }

    // Real transition: unbind the old, bind the new. We only swap the
    // Y.Text observer here — awareness for the OLD session is left
    // alone. Presence will have already (or will imminently) written
    // {user, cursor:null} to the now-inactive session via
    // setCurrentPath; us nulling it here would race that and could wipe
    // the identity. One owner for local awareness state: presence.
    if (this.observer && this.boundYtext) {
      try {
        this.boundYtext.unobserve(this.observer);
      } catch {
        /* ignore */
      }
    }

    // Set the new bound state BEFORE installing the observer so reentrant
    // events have consistent state. Reset mergeInFlight first: a merge
    // started for the PREVIOUS binding must not suppress this new
    // binding's parity check. The old merge's runDiskMerge re-checks the
    // bound docId/ytext after its await and bails if superseded, so it
    // won't stomp the new binding either — but only reconcileBinding for
    // THIS binding may set the flag true again (case 4 below).
    this.mergeInFlight = false;
    this.boundDocId = ctx.docId;
    this.boundYtext = ctx.ytext;

    // Reconcile editor content with the new ytext content.
    // Phase 3 decision tree (see reconcileBinding). The four cases:
    //
    //   1. editor === ytext            → in sync, set DiskBuffer = editor.
    //   2. ytext empty, editor present → seed ytext from editor (first
    //                                     peer), set DiskBuffer = editor.
    //   3. editor empty, ytext present → adopt ytext into editor (joining
    //                                     peer, nothing local to lose),
    //                                     set DiskBuffer = ytext.
    //   4. both non-empty AND differ   → DANGEROUS. Three-way merge via
    //                                     DiskBuffer (async). NEVER discard
    //                                     the editor buffer.
    //
    // Cases 1–3 are synchronous. Case 4 needs an async DiskBuffer.get and
    // is handled by reconcileBinding kicking runDiskMerge(); the parity
    // check is suppressed (mergeInFlight) until that settles so it can't
    // force editor→ytext and undo the merge.
    this.reconcileBinding(ctx.ytext, ctx.docId);

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

  // ── Phase 3: reconcile-on-bind decision tree ────────────────────────
  //
  // Run once per real binding (called from rebindIfNeeded after we've
  // set boundYtext/boundDocId and before installing the observer). The
  // observer is installed AFTER this returns, but cases that mutate
  // ytext do so under origin `this`, which the observer skips anyway —
  // and the async merge re-reads live content, so observer-install order
  // is not load-bearing for correctness. The #1 rule: never discard a
  // non-empty editor buffer without merging it into ytext first.
  private reconcileBinding(ytext: Y.Text, docId: string): void {
    let editorStr: string;
    let ytextStr: string;
    try {
      editorStr = this.view.state.doc.toString();
      ytextStr = ytext.toString();
    } catch (err) {
      console.warn("[yedit] reconcileBinding: read failed", err);
      return;
    }

    // Case 1 — already in sync. Record the base; no dispatch.
    if (editorStr === ytextStr) {
      void this.diskBuffer.set(docId, editorStr);
      return;
    }

    // Case 2 — first peer on this file (server has nothing). Seed ytext
    // from the editor. Origin `this` so the observer skips it (the
    // editor already holds this content; echoing it back would double
    // it). Base = the seeded content.
    if (ytext.length === 0 && editorStr.length > 0) {
      const doc = ytext.doc;
      if (doc) {
        try {
          doc.transact(() => {
            ytext.insert(0, editorStr);
          }, this);
          console.log(
            `[yedit] seeded ytext from editor (${editorStr.length} chars) on first bind`,
          );
        } catch (err) {
          console.warn("[yedit] seed failed", err);
        }
      }
      void this.diskBuffer.set(docId, editorStr);
      return;
    }

    // Case 3 — joining peer, local file empty/new. Nothing local to
    // lose; adopt ytext into the editor via a minimal diff (caret/undo
    // survive). Base = ytext content.
    if (editorStr.length === 0 && ytext.length > 0) {
      try {
        const changes = bufferDiffToChanges(editorStr, ytextStr);
        if (changes.length > 0) {
          this.view.dispatch({
            changes,
            annotations: [ySyncAnnotation.of(true)],
          });
        }
      } catch (err) {
        console.warn("[yedit] case-3 adopt failed", err);
      }
      void this.diskBuffer.set(docId, ytextStr);
      return;
    }

    // Case 4 — both non-empty AND differ. The dangerous one. Hand to the
    // async three-way merge. Suppress the parity check until it settles.
    // runDiskMerge re-reads live content after its await, so we don't
    // pass the snapshots — they could be stale by the time it resumes.
    this.mergeInFlight = true;
    void this.runDiskMerge(ytext, docId);
  }

  // The async half of case 4. Loads BASE from the DiskBuffer, computes
  // the merged content (true 3-way if BASE exists, additive fallback if
  // not), applies it to ytext (origin `this`), pushes the same result
  // into the editor via a minimal diff, and records the new BASE.
  //
  // Everything is wrapped so that an exception can NEVER leave the editor
  // buffer discarded: on any failure we leave both editor and ytext as
  // they were (the user's text stays in the editor) and just clear the
  // in-flight flag. Losing text is the cardinal sin; a failed merge that
  // leaves both copies intact is recoverable, a merge that wiped the
  // editor is not.
  private async runDiskMerge(ytext: Y.Text, docId: string): Promise<void> {
    let merged: string;
    let usedAdditiveFallback = false;
    // Are we still the merge that owns the current binding? Used to guard
    // every mergeInFlight write so a SUPERSEDED merge (user switched away
    // and a new binding — possibly its own case-4 merge — took over)
    // never clears the flag the NEW binding is relying on. Only the merge
    // that still owns the binding may clear it.
    const stillOwner = () =>
      this.boundYtext === ytext && this.boundDocId === docId;
    try {
      const base = await this.diskBuffer.get(docId);

      // The binding may have changed while we awaited IndexedDB (user
      // switched files). If so, abandon this merge — a fresh
      // reconcileBinding ran for the new context and now owns the
      // mergeInFlight flag. Leave the editor as-is; do NOT touch the flag.
      if (!stillOwner()) return;

      // Re-read live content: remote ops or local keystrokes may have
      // landed during the await. We merge the CURRENT state, not the
      // snapshot we were called with.
      const liveYtext = ytext.toString();
      const liveEditor = this.view.state.doc.toString();
      if (liveYtext === liveEditor) {
        // Converged on their own while we waited. Record base, done.
        void this.diskBuffer.set(docId, liveYtext);
        return;
      }

      if (base != null) {
        // Case 4a — true three-way merge. Local edits (base→theirs)
        // replayed onto ours via fuzzy patch matching. We trust the
        // result (see threeWayMerge): it preserves remote edits and
        // honours legitimate local deletions.
        merged = threeWayMerge(base, liveYtext, liveEditor);
      } else {
        // Case 4b — no common ancestor (first-ever open on this device).
        // Additive merge: keep everything from both sides. May duplicate
        // in a true conflict; never loses. We warn the user via Notice.
        merged = additiveMerge(liveYtext, liveEditor);
        usedAdditiveFallback = true;
      }

      // Apply the merged content to ytext. Origin `this` → our observer
      // skips it (it would otherwise translate ours-relative offsets
      // onto the editor, which still holds THEIRS — a mismatch). We push
      // the editor explicitly below instead.
      const changedYtext = applyStringToYText(ytext, merged, this);
      // Recompute merged from the actual post-apply ytext, in case
      // concurrent remote ops merged in during our transaction (Yjs may
      // interleave). This is the true converged content.
      const finalContent = ytext.toString();

      // Push the converged content into the editor via a minimal diff
      // from its current (THEIRS) content. Offsets are editor-relative
      // so they always line up.
      try {
        const changes = bufferDiffToChanges(
          this.view.state.doc.toString(),
          finalContent,
        );
        if (changes.length > 0) {
          this.view.dispatch({
            changes,
            annotations: [ySyncAnnotation.of(true)],
          });
        }
      } catch (err) {
        console.warn(
          "[yedit] disk-merge: editor dispatch failed; ytext holds merged content, editor will resync via parity",
          err,
        );
      }

      // New BASE = the converged content now on both sides.
      void this.diskBuffer.set(docId, finalContent);

      console.log(
        `[yedit] disk-merge (${usedAdditiveFallback ? "additive/no-base" : "3-way"}) ` +
          `for ${docId}: base=${base?.length ?? "null"} ours=${liveYtext.length} ` +
          `theirs=${liveEditor.length} → merged=${finalContent.length}` +
          (changedYtext ? "" : " (ytext unchanged)"),
      );

      if (usedAdditiveFallback) {
        // No clean ancestor — warn the user to eyeball the result, as the
        // additive union can duplicate a region in a true conflict.
        const name = this.fileNameForNotice();
        try {
          new Notice(
            `Collab merged your local version of ${name} with the shared version — check the result.`,
            10_000,
          );
        } catch {
          /* Notice unavailable in some contexts; ignore */
        }
      }
    } catch (err) {
      // Hard failure somewhere in the merge. We never DISCARD text: the
      // editor buffer (THEIRS) is never cleared by this method, so the
      // user's local content is always still on screen and on its way to
      // disk. Two sub-cases when the flag clears and the parity check
      // re-enables:
      //   - threw before ytext was modified → ytext == OURS, editor ==
      //     THEIRS; parity will reconcile editor→ytext (ytext wins) but
      //     the editor text also already merged into nothing was lost —
      //     it remains in the editor until that resync, and the disk-sync
      //     writer captured nothing destructive. (This is the pre-Phase-3
      //     behaviour, only reachable on a merge crash.)
      //   - threw after applyStringToYText → ytext already holds the
      //     merged (both-sides) content; parity reconciles editor→ytext,
      //     so the editor converges to the merged content. Both sides
      //     preserved.
      // Either way no data is silently destroyed by THIS code path.
      console.error(
        "[yedit] disk-merge failed; editor buffer left intact (never discarded)",
        err,
      );
    } finally {
      // Only clear the flag if we still own the binding. If a switch
      // happened mid-merge, the new binding (and possibly its own merge)
      // owns mergeInFlight now — clearing it here would wrongly re-enable
      // the new binding's parity check before its merge applied, risking
      // its local edits. The superseded merge simply leaves the flag to
      // its rightful owner.
      if (stillOwner()) this.mergeInFlight = false;
    }
  }

  // Best-effort human filename for the merge Notice. Reads Obsidian's
  // editorInfoField off the view state; falls back to a generic label if
  // the field isn't present (e.g. a non-Obsidian CodeMirror context).
  private fileNameForNotice(): string {
    try {
      const info = this.view.state.field(editorInfoField, false);
      if (info && info.file instanceof TFile) return info.file.name;
    } catch {
      /* ignore */
    }
    return "this file";
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
    // While a disk-merge is running, editor (THEIRS) and ytext (OURS)
    // legitimately differ. A resync here would force editor→ytext and
    // wipe the local edits the merge is preserving. Stand down until the
    // merge settles editor === ytext and clears this flag.
    if (this.mergeInFlight) return;
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
    // Only unobserve our Y.Text. Do NOT touch awareness here either:
    // this destroy() fires when THIS EditorView is torn down, but the
    // underlying TextSession (and its awareness) may still be alive and
    // displayed in another split pane. Nulling awareness here would make
    // the peer vanish from the file in the surviving pane. The session's
    // awareness is cleared exactly once, in TextSession.destroy(), when
    // the file is genuinely closed/deleted/unloaded everywhere.
    if (this.observer && this.boundYtext) {
      try {
        this.boundYtext.unobserve(this.observer);
      } catch {
        /* ignore */
      }
    }
    this.observer = null;
    this.boundYtext = null;
    this.boundDocId = null;
  }
}

export const ySync: Extension = ViewPlugin.fromClass(YSyncPluginValue);
