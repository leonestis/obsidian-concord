// SPDX-License-Identifier: MIT
// See LICENSE.upstream (yjs/y-codemirror.next) and LICENSE.relay (No-Instructions/Relay).
//
// Top-level export. Mirrors upstream's `yCollab(ytext, undoManager, opts)`
// entry point, but takes a `resolveContext` function instead of captured
// ytext + awareness. The function is read out of the Facet on every
// callback in the underlying plugins — that's the structural fix for
// Obsidian's view-recycling.
//
// Use:
//
//   const compartment = new Compartment();
//   editor.dispatch({
//     effects: compartment.reconfigure(
//       yCollab((view) => liveViewManager.resolveContext(view))
//     ),
//   });
//
// And when releasing a leaf:
//
//   editor.dispatch({
//     effects: compartment.reconfigure(yCollab(/* same resolver */)),
//   });
//   // resolveContext now returns { active: false } for this view; the
//   // plugins go inert without losing their identity.
//
// Phase 3 added the DiskBuffer-mediated 3-way merge between ytext,
// editor doc, and on-disk content — it lives inside ySync's reconcile-
// on-bind path (see y-sync.ts reconcileBinding / runDiskMerge) and
// needed no new extension here, so the resolver contract is unchanged.

import { Annotation, type Extension } from "@codemirror/state";

import {
  resolveContextFacet,
  ySync,
  ySyncAnnotation,
  type ResolveContext,
  type YeditContext,
} from "./y-sync";

// An annotation we attach to "wake" transactions dispatched by
// LiveViewManager to force yedit's update() cycle to run after a
// session becomes available outside any normal editor interaction.
// Carrying just an annotation in a transaction is enough for
// CodeMirror to fire update() on every ViewPlugin.
export const yeditWake = Annotation.define<true>();
import {
  yRemoteSelections,
  yRemoteSelectionsTheme,
} from "./y-remote-selections";

export interface YCollabOptions {
  // Future-proofing. Nothing to put here yet — the Phase 3 disk-buffer
  // wiring is internal to ySync and the DiskBuffer singleton, so it
  // needed no option surface.
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
}

export function yCollab(
  resolveContext: ResolveContext,
  _opts: YCollabOptions = {},
): Extension {
  return [
    resolveContextFacet.of(resolveContext),
    ySync,
    yRemoteSelections,
    yRemoteSelectionsTheme,
  ];
}

// Re-exports so callers can import everything from the package root.
export { ySyncAnnotation };
export type { ResolveContext, YeditContext };
