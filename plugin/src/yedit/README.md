# yedit — vendored y-codemirror.next, dynamic context flavor

This directory is the obsidian-collab fork of [yjs/y-codemirror.next](https://github.com/yjs/y-codemirror.next), shaped after No-Instructions/Relay's reforking of the same library. Both originals are MIT-licensed — see `LICENSE.upstream` and `LICENSE.relay`.

## Why we forked

The upstream `yCollab(ytext, undoManager, { awareness })` extension captures `ytext` and `awareness` in the constructor of its `ySync` / `yRemoteSelections` plugins. In a long-lived editor that always binds to the same Y.Text — say, a CodeMirror playground page — that's fine. In Obsidian it is not.

Obsidian reuses a single `EditorView` across every file you open in a pane. When you switch from `A.md` to `B.md`, the framework keeps the same `EditorView` alive, calls `setViewData(B's text)` on it, and only the `Compartment.reconfigure(...)` you dispatch from your plugin code rewires which Y.Text it should be talking to. The catch:

- ViewPlugins identified by `ViewPlugin.fromClass(...)` are remembered by their *constant identity*. CodeMirror sees the new compartment contents reference the same plugin constant, calls `update()` on the existing instance instead of rebuilding it, and the instance's constructor-captured `this.conf.ytext` still points at A.
- Even `Facet.define()` doesn't help: the facet value is recomputed but the plugin instance read it once in its constructor.

This is the bug tracked upstream at [yjs/y-codemirror.next#19](https://github.com/yjs/y-codemirror.next/issues/19), never fixed. v0.9 of this plugin worked around it by minting *fresh* ViewPlugin instances every time we wanted to rebind (see the pre-v2.0 `collab-binding.ts`). That works, but every rebind tears down the awareness observer for one tick; in that one tick any awareness change is silently dropped. Result: peers go invisible at random.

Relay's fix is to keep the plugin instance *stable* and resolve the context lazily on every `update()` and every observer callback. That is what this directory implements.

## Architecture

`y-collab.ts` exports a single `yCollab(resolveContext, opts)` entry point. The caller — `LiveViewManager` in our case — provides a function that, given an `EditorView`, returns the right `{ ytext, awareness, docId, active }` for the file currently displayed in that view (or `null` if there is no live session yet). The plugins call `resolveContext(view)` at the top of every observer body and every `update()` cycle.

If `resolveContext` returns `null` (no manifest entry, or session not bound, or this isn't a recognised vault file), the plugins no-op. The compartment can stay loaded with the plugins; they just stay inert until a real session resolves. This eliminates Relay's CSS-class allowlist gymnastics — we don't need a `.relay-live-editor` self-destruct marker because the inert path is just `return` in every callback.

When `resolveContext` returns a *different* docId from the one the plugin last saw, the plugin re-binds:

1. Unobserve the previous `Y.Text` (if any).
2. Remove our local awareness state from the previous awareness via `removeAwarenessStates(prevAwareness, [prevAwareness.clientID], 'switch')`. Peers see our cursor in the old file vanish immediately, not after a 30 s heartbeat timeout.
3. Observe the new `Y.Text`.
4. Reconcile the editor's current doc against the new `Y.Text` content via `diff-match-patch` and dispatch the resulting `ChangeSpec[]` (annotated with `ySyncAnnotation` so the editor→Y.Text path doesn't echo it back).
5. Subscribe to the new awareness `change` events. Decorations rebuild on the next `update()`.
6. Initial cursor + user state is set by `LocalPresenceController` (not by these plugins directly) right after we transition.

The actual cursor publication on selection changes still happens here — the ViewPlugin has the editor selection in hand and knows when to translate it into a `Y.RelativePosition`. But the "I'm in file X right now, null the cursor in every other file" handoff is `LocalPresenceController`'s job.

## File map

- `y-sync.ts` — editor ↔ Y.Text. Mirrors upstream's `ySync`, but with dynamic `resolveContext` and a defensive parity check (editor.length vs ytext.length) that triggers a full-document resync on divergence. Pulled diff-match-patch in for the rebind path because a fresh full-document overwrite would lose CodeMirror's selection / undo state.
- `y-remote-selections.ts` — awareness → remote caret decorations. Mirrors upstream's `yRemoteSelections` + Relay's defensive null-checks at the top of every observer body.
- `y-collab.ts` — top-level export. Exports `yCollab(resolveContext)` plus the `ySyncAnnotation` constant the rest of the codebase uses to identify Y-sourced transactions.

## What didn't get copied

- The undo manager wiring from upstream. Obsidian has its own undo stack and the upstream wiring fights it. v0.9.x didn't have it either; this is no regression.
- Attribution decorations (`@y/y` newer-version features). The plugin doesn't surface authorship per-character today.
- Relay's `LiveNode`, `AwarenessViewPlugin`, `CanvasPlugin`, `TextFileViewPlugin` — those are Relay-specific concerns (their canvas / kanban / live nodes UX). Our canvas presence already has its own implementation in `canvas-cursors.ts` and is explicitly off-limits.

## Migration from v1.x's `collab-binding.ts`

`collab-binding.ts` was deleted in v2.0.0. Its responsibilities split:

- Editor ↔ Y.Text dispatch loop → `yedit/y-sync.ts`.
- Remote caret rendering → `yedit/y-remote-selections.ts`.
- Awareness handoff between files → `local-presence.ts`.
- Editor binding lifecycle (which view binds to which file when) → `live-view-manager.ts`.

The old freshly-minted-ViewPlugin-on-every-rebind trick is no longer needed because the plugin instance is now intentionally stable across rebinds — only the resolved context changes.
