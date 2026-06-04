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

import { TFile, editorInfoField } from "obsidian";
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
  // ── data-corruption fix wiring (invariants I2, I3, I5) ──────────────
  // The session's current vault path. Used for the file-identity check
  // (I5): the editor must be showing THIS file before we reconcile.
  sessionPath: string;
  // Where this markdown session originated (I3). Only "local" may seed
  // the editor's content into an empty ytext.
  origin: "local" | "remote";
  // I2: has the session's provider genuinely synced? Reconcile is
  // forbidden until true.
  isSynced: () => boolean;
  // Register to be re-poked when the session truly syncs. Returns an
  // unsubscribe. The binding uses this to re-run reconcile once the
  // server's state arrives (instead of acting on a not-yet-synced doc).
  onSynced: (cb: () => void) => () => void;
  // SERVER-WINS backup (I4): persist `localContent` to a local-only
  // backup sibling, Notice the user. Used when there's no base and the
  // editor content differs from the synced ytext. Async; resolves true
  // on success (safe to adopt ytext), false on failure (do NOT adopt).
  backupLocal: (localContent: string) => Promise<boolean>;
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
export function threeWayMerge(base: string, ours: string, theirs: string): string {
  // Local edits as patches against base.
  const patches = dmp.patch_make(base, theirs);
  if (patches.length === 0) return ours; // no local edits → ours wins
  const [merged] = dmp.patch_apply(patches, ours);
  return merged;
}

// NOTE: the old `additiveMerge` (no-BASE union of both sides) was
// REMOVED in the data-corruption fix. Merging without a BASE is exactly
// what produced Bug 1's garbage — when there is no base we cannot tell a
// genuine offline edit from a different file's content, so the only safe
// action is SERVER WINS + back up local (see reconcileBinding step 4 and
// TextSession.backupLocalContent). There is no additive path anymore.

// Apply a target string onto a Y.Text as minimal insert/delete ops,
// computed by diffing the Y.Text's CURRENT content against the target.
// Offsets are therefore relative to the live ytext, so they always line
// up. Runs inside one transaction with the given origin. Returns true if
// any op was applied.
export function applyStringToYText(
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
  // I2: when a bind happens before the session has truly synced, we
  // defer reconcile and register here to be re-poked on real sync. Held
  // so a rebind/teardown can cancel a stale waiter.
  private syncWaitUnsub: (() => void) | null = null;

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
      this.cancelSyncWait();
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
    // A sync-wait registered for the PREVIOUS binding must not fire a
    // reconcile against the new one.
    this.cancelSyncWait();

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

    // Reconcile editor content with the new ytext content — gated by
    // the data-corruption invariants (I2 true-sync, I5 file-identity,
    // I3 origin, I4 base-required). See reconcileBinding.
    this.reconcileBinding(ctx);

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

  // Cancel a pending I2 sync-wait (if any). Idempotent.
  private cancelSyncWait(): void {
    if (this.syncWaitUnsub) {
      try {
        this.syncWaitUnsub();
      } catch {
        /* ignore */
      }
      this.syncWaitUnsub = null;
    }
  }

  // The vault path the editor is CURRENTLY displaying, via Obsidian's
  // editorInfoField. null if unavailable / not an Obsidian file context.
  // Used for the I5 file-identity check.
  private editorFilePath(): string | null {
    try {
      const info = this.view.state.field(editorInfoField, false);
      if (info && info.file instanceof TFile) return info.file.path;
    } catch {
      /* ignore */
    }
    return null;
  }

  // ── INVARIANT-COMPLIANT reconcile-on-bind decision tree ─────────────
  //
  // Run once per real binding (and re-run via onSynced if the session
  // hadn't truly synced yet). Enforces, in order:
  //
  //   I5 (file identity): the editor must currently be showing the SAME
  //       file as the session we're reconciling against. On a fast file
  //       switch the recycled EditorView briefly still holds the previous
  //       file's text; reconciling then would inject fileA's text into
  //       fileB's ytext (Bug 2). If editorInfoField.file.path !==
  //       ctx.sessionPath, ABORT — the bind reruns cleanly once the
  //       editor settles (a wake/update will re-call us).
  //
  //   I2 (true sync only): if the session's provider hasn't genuinely
  //       synced, the editor shows disk content and we do NOTHING
  //       destructive. We register onSynced to re-run this reconcile when
  //       the server's state truly arrives.
  //
  //   Then the decision tree (I1/I3/I4/I6) with editor as "local":
  //     1. origin==="local" AND ytext empty → seed ytext from editor
  //        (OUR brand-new file). The only editor→ytext seed.
  //     2. editor === ytext → in sync, record base.
  //     3. base exists → real 3-way merge (legit offline-edit case).
  //     4. no base:
  //          - editor empty → adopt ytext into editor.
  //          - editor non-empty, differs → SERVER WINS: back up editor
  //            content to a local-only file, then adopt ytext. NEVER
  //            additively merge into the shared doc.
  private reconcileBinding(ctx: YeditContext): void {
    const { ytext, docId } = ctx;

    // I5 — file identity. The editor must be on THIS session's file.
    const editorPath = this.editorFilePath();
    if (editorPath !== null && editorPath !== ctx.sessionPath) {
      console.log(
        `[yedit] reconcile aborted (I5): editor shows ${editorPath}, session is ${ctx.sessionPath} — will rerun once editor settles`,
      );
      return;
    }

    // I2 — only on a genuine sync. If not yet synced, defer: do nothing
    // destructive, and re-run when the server's state truly arrives.
    if (!ctx.isSynced()) {
      this.cancelSyncWait();
      this.syncWaitUnsub = ctx.onSynced(() => {
        this.syncWaitUnsub = null;
        // Still bound to the same context? (A switch may have happened
        // while we waited.) If not, the new binding owns reconcile.
        if (this.boundYtext !== ytext || this.boundDocId !== docId) return;
        if (!this.view.dom.isConnected) return;
        this.reconcileBinding(ctx);
      });
      console.log(
        `[yedit] reconcile deferred (I2): session ${ctx.sessionPath} not yet synced — waiting for true sync`,
      );
      return;
    }

    let editorStr: string;
    let ytextStr: string;
    try {
      editorStr = this.view.state.doc.toString();
      ytextStr = ytext.toString();
    } catch (err) {
      console.warn("[yedit] reconcileBinding: read failed", err);
      return;
    }

    // Step 1 — OUR brand-new file, empty server room (I3). Seed ytext
    // from the editor. Origin `this` so the observer skips it. This is
    // the ONLY editor→ytext seed permitted.
    if (ctx.origin === "local" && ytext.length === 0 && editorStr.length > 0) {
      const doc = ytext.doc;
      if (doc) {
        try {
          doc.transact(() => {
            ytext.insert(0, editorStr);
          }, this);
          console.log(
            `[yedit] seeded ytext from editor (${editorStr.length} chars) — local origin, brand-new room`,
          );
        } catch (err) {
          console.warn("[yedit] seed failed", err);
        }
      }
      void this.diskBuffer.set(docId, editorStr);
      return;
    }

    // Step 2 — already in sync. Record base; no dispatch.
    if (editorStr === ytextStr) {
      void this.diskBuffer.set(docId, editorStr);
      return;
    }

    // Steps 3/4 need an async DiskBuffer.get. Suppress the parity check
    // until it settles so it can't force editor→ytext and undo us.
    this.mergeInFlight = true;
    void this.runReconcileMerge(ctx);
  }

  // Async tail of reconcileBinding (steps 3/4). Loads BASE; if present
  // does a real 3-way merge (legit offline-edit case). If absent: server
  // wins — adopt ytext into the editor, backing up the editor's content
  // to a local-only file first when it's non-empty and differs (I4). It
  // NEVER additively merges into the shared doc (the Bug-1 corruption
  // source) and NEVER discards the editor buffer without first backing
  // it up.
  private async runReconcileMerge(ctx: YeditContext): Promise<void> {
    const { ytext, docId } = ctx;
    const stillOwner = () =>
      this.boundYtext === ytext && this.boundDocId === docId;
    try {
      const base = await this.diskBuffer.get(docId);
      if (!stillOwner()) return;
      // I5 again: the editor may have switched files during the await.
      const editorPath = this.editorFilePath();
      if (editorPath !== null && editorPath !== ctx.sessionPath) return;

      // Re-read live content: remote ops / keystrokes may have landed.
      const liveYtext = ytext.toString();
      const liveEditor = this.view.state.doc.toString();
      if (liveYtext === liveEditor) {
        void this.diskBuffer.set(docId, liveYtext);
        return;
      }

      if (base != null) {
        // Step 3 — true 3-way merge. Local edits (base→editor) replayed
        // onto ours (ytext) via fuzzy patch matching. Preserves remote
        // edits and honours legitimate local deletions.
        const merged = threeWayMerge(base, liveYtext, liveEditor);
        applyStringToYText(ytext, merged, this);
        const finalContent = ytext.toString();
        this.pushEditor(finalContent);
        void this.diskBuffer.set(docId, finalContent);
        console.log(
          `[yedit] reconcile 3-way for ${docId}: base=${base.length} ours=${liveYtext.length} theirs=${liveEditor.length} → ${finalContent.length}`,
        );
        return;
      }

      // Step 4 — NO base. We cannot distinguish offline edits from a
      // different file's content, so we must NOT merge into the shared
      // doc. Server wins.
      if (liveEditor.length === 0) {
        // Nothing local to lose — adopt ytext into the editor.
        this.pushEditor(liveYtext);
        void this.diskBuffer.set(docId, liveYtext);
        console.log(
          `[yedit] reconcile no-base, editor empty → adopt ytext (${liveYtext.length})`,
        );
        return;
      }
      // editor non-empty AND differs from ytext → back up local, adopt.
      const backedUp = await ctx.backupLocal(liveEditor);
      if (!stillOwner()) return;
      if (!backedUp) {
        // Backup failed — do NOT discard the editor content. Leave it;
        // a future true-sync/rebind retries. (The editor still holds the
        // user's text, so nothing is lost.)
        console.warn(
          `[yedit] reconcile no-base, backup FAILED for ${docId} — leaving editor content intact, not adopting`,
        );
        return;
      }
      // Backup safe — adopt ytext into the editor.
      const adoptYtext = ytext.toString();
      this.pushEditor(adoptYtext);
      void this.diskBuffer.set(docId, adoptYtext);
      console.log(
        `[yedit] reconcile no-base, server wins for ${docId}: backed up editor (${liveEditor.length}), adopted ytext (${adoptYtext.length})`,
      );
    } catch (err) {
      // Never discard the editor buffer on failure — the user's content
      // stays on screen and flows to disk. Recoverable.
      console.error(
        "[yedit] reconcile merge failed; editor buffer left intact (never discarded)",
        err,
      );
    } finally {
      if (stillOwner()) this.mergeInFlight = false;
    }
  }

  // Push `content` into the editor via a minimal diff from its current
  // text (caret/undo survive). Annotated so our observer/forward skip it.
  private pushEditor(content: string): void {
    try {
      const changes = bufferDiffToChanges(this.view.state.doc.toString(), content);
      if (changes.length > 0) {
        this.view.dispatch({
          changes,
          annotations: [ySyncAnnotation.of(true)],
        });
      }
    } catch (err) {
      console.warn(
        "[yedit] pushEditor dispatch failed; parity will resync editor to ytext",
        err,
      );
    }
  }

  // Forward editor changes into ytext. Skips our own Y-annotated
  // transactions (the loop breaker).
  update(update: ViewUpdate): void {
    const ctx = this.rebindIfNeeded();
    if (!ctx || !ctx.active) return;

    // I2 + I5 gate on the editor→ytext forward path. Until the session
    // has TRULY synced, ytext is not trustworthy (server state may not
    // have arrived), and the editor may be showing disk content for a
    // remote-origin file — forwarding it would push local content into
    // the shared doc (violating I1). Likewise if the editor is showing a
    // DIFFERENT file than the bound session (mid-switch), forwarding
    // would cross-contaminate (Bug 2). In both cases: do not forward and
    // do not run the parity check (which could also force editor→ytext).
    // The bound observer (ytext→editor) is unaffected, and the reconcile
    // re-runs once synced / once the editor settles on the right file.
    if (!ctx.isSynced()) return;
    {
      const editorPath = this.editorFilePath();
      if (editorPath !== null && editorPath !== ctx.sessionPath) return;
    }

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
    this.cancelSyncWait();
    this.observer = null;
    this.boundYtext = null;
    this.boundDocId = null;
  }
}

export const ySync: Extension = ViewPlugin.fromClass(YSyncPluginValue);
