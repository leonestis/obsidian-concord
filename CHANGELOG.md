# Changelog

All notable changes are recorded here. The project loosely follows [Semantic Versioning](https://semver.org/) — patch bumps for fixes, minor for features, major for breaking changes.

## 0.8.1 — 2026-05-25

### Changed
- **Peer cursors now change shape to match what the peer is doing**, the same way the OS cursor on the local side already does: an arrow over empty canvas, an open hand when hovering a node, a closed/grabbing hand while moving a node. The SVG is swapped on the receiving side based on the `action` field — no more text suffixes on the label.
- **Cursor label is just the name again** — `name`, not `name · selecting` / `name · dragging`. Activity is communicated by the SVG variant instead, which is more like Figma and less like a chat log.
- **Smooth cursor motion via per-frame interpolation.** Network samples arrive at ~30 Hz with jitter, so previously the cursor would tele-snap to each new packet and feel laggy. The render loop now lerps the on-screen position toward the latest received target by ~0.28 per frame (rAF-driven), which produces continuous motion between samples without adding measurable delay. Big jumps (>500 px — e.g. peer panned the canvas) snap rather than crawl.

### Added
- **Marquee selection rectangle.** When a peer drags on empty canvas to select a region (the dashed rectangle you see in Obsidian's own UI), that rectangle is broadcast in world coordinates and rendered as a tinted dashed box on every other peer's screen at ~30 Hz. Vanishes the moment the peer releases the mouse.
- New `action` value `marquee` and `hover` (replaces the earlier `selecting`).

### Removed
- Action-suffixed cursor labels. The variant SVG carries that information now.

## 0.8.0 — 2026-05-25

### Added
- **Canvas Phase 2 + 3: live selection + live drag preview.** The canvas overlay now shows, for every connected peer, (a) a colored frame around each node the peer has selected, and (b) a dashed ghost rectangle of where the peer is currently dragging a node to — updated at ~30 Hz so the motion is smooth, not stutter-stepped from save round-trips. When the peer releases the mouse the ghost vanishes and the eventual settled position arrives via the normal canvas-file save path (Y.Doc → JSON → disk). Everything ephemeral travels over Awareness so we don't churn the `.canvas` file once per frame.
- **Action-aware cursors.** Each peer's cursor now carries an `action` field — `idle`, `selecting`, or `dragging` — and the label changes accordingly (`name`, `name · selecting`, `name · dragging`). The SVG also shifts a tiny bit (subtle squeeze on drag, brighter drop-shadow) so the collaborator's activity reads at a glance, like in Figma.
- **Selection sync poll** at 150 ms and **drag-position poll** at 33 ms, both running on the local side and publishing into Awareness. Reads are defensive against whether `canvas.selection` / `canvas.nodes` is a `Set`, `Map`, plain object, or array — Obsidian's canvas internals are undocumented and the shape has differed between builds historically.
- Positions for selection outlines and drag ghosts are exchanged in WORLD coordinates and projected to each peer's screen using the same probed affine inverse introduced in 0.7.2, so two viewers at different pan/zoom both see the outline aligned with the actual node.

### Notes
- Phase 4 (live add / delete / edit / connect) still relies on the existing save-debounce path — when a peer adds, deletes, edits, or connects nodes the change arrives via the normal Y.Doc canvas-JSON sync after Obsidian's save fires. That's typically sub-second but not frame-rate. A true real-time Phase 4 would need direct hooks into Canvas's internal mutation methods, which we're deferring until Obsidian's plugin API surfaces them publicly — monkey-patching private APIs there is the most version-fragile thing we could do.
- The `drag` ghost is purely visual; we never mutate the peer's local `canvas.nodes` object behind the scenes. The peer's actual nodes only move when the save round-trip lands. This keeps the receive side cheap and avoids fighting Obsidian's own canvas renderer.

## 0.7.2 — 2026-05-24

### Fixed
- **Canvas cursors are world-anchored again** (proper fix this time). 0.7.0 tried to compute world-space coordinates from `canvas.x/y/zoom` directly and got the sign conventions wrong, producing mirrored cursors. 0.7.1 worked around that by dropping world coordinates entirely and shipping wrapper-relative pixels — direction was correct but a cursor in the same logical document point appeared at different screen positions on iPhone vs desktop. This release computes world coordinates the safe way: use `canvas.posFromEvt(evt)` (Obsidian's own screen→world helper) to publish, and **probe** the inverse by synthesising MouseEvents at known wrapper-local pixel offsets and reading the world coords posFromEvt returns. The affine inverse is derived from those samples, independent of whatever the underlying canvas zoom/pan representation looks like. Now a cursor pointed at the corner of a node on one peer shows up at the corner of that same node on the other peer regardless of pan, zoom, or viewport size.
- The wire format gained a `mode: "world" | "screen"` field on the cursor payload so older peers (0.7.1) and newer peers can coexist gracefully. If a peer publishes `"screen"` mode we render at wrapper-local pixels; if `"world"` we apply the probed inverse.

## 0.7.1 — 2026-05-24

### Fixed
- **Mirrored canvas cursors.** 0.7.0 published cursor positions in canvas-WORLD coordinates by feeding `canvas.x/y/zoom` into a standard pan-zoom transform. Those properties exist on the live Obsidian canvas object but their semantics don't match the standard formula — the result was that a peer's cursor moved in the opposite direction on the receiving side. Phase 1 now uses wrapper-relative pixel coordinates (no world transform), which guarantees correct movement direction at the cost of cursor positions diverging from the actual document point when peers have different pan/zoom states. Phase 2 will fix this properly by reading the canvas's actual transform via Obsidian's `posFromEvt` and a probed inverse instead of guessing the math.

## 0.7.0 — 2026-05-24

### Added
- **Live cursors on Canvas (Phase 1 of full canvas realtime).** Every canvas session now publishes the local mouse position into the canvas's Yjs Awareness (throttled ~30 Hz), and renders an absolutely-positioned overlay over `.canvas-wrapper` showing every other connected user's cursor — Figma-style arrow with the user's name and color. Positions are stored in canvas WORLD coordinates so two viewers panned/zoomed differently still see the cursor at the same conceptual point in the document.
- New `plugin/src/canvas-cursors.ts` module. Defensive against unannounced Obsidian internal API drift — falls back to manual rect/zoom/pan math if `canvas.posFromEvt` is missing on a particular build.
- Idempotent attachment: opening the same canvas in multiple panes (or reloading the leaf) doesn't double-attach the listeners; an `data-collab-attached` marker on the wrapper guards re-entry.

### Notes
- This is Phase 1 of a planned 4-phase canvas realtime push. Subsequent releases add: (2) live selection sync — highlight nodes other users have selected; (3) live drag — see node positions update in real time as a peer drags, without waiting for Obsidian's debounced save round-trip; (4) live add / delete / edit / connect operations. Each builds on monkey-patching internal `CanvasView` / `Canvas` methods and is more fragile to Obsidian's release cycle.
- Cursor overlay only shows up when the canvas leaf is in the foreground. Background canvas tabs don't render until you switch to them.
- On mobile (no mouse) the publisher does nothing for now; touch / pencil tracking is a separate hook.

## 0.6.5 — 2026-05-24

Mops up the residual items the 0.6.3 changelog tagged "follow-up".

### Fixed
- **Persistence destroy now sequential.** `destroySession` and `closeStructuralSession` previously did `void session.persistence.destroy()` then immediately `session.ydoc.destroy()`. `IndexeddbPersistence.destroy()` is async — a flush in progress could end up writing into an already-torn-down doc. Both methods are now `async` and `await` the persistence cleanup before destroying the provider and the Y.Doc. All callers (`onunload`, `reconnect`, `onRename`, `onDelete`, `stopVaultSync`, `onLocalVault{Delete,Rename}`) updated to await or fire-and-forget as appropriate.
- **`attachFile` socket race.** Captured `this.socket` into a local at function entry. `createSession` now takes the socket as an explicit parameter rather than reading `this.socket!` inside its async body, so a reconnect that nulls `this.socket` mid-flight no longer leaves a half-constructed session pointing at a dead reference.
- **`reconcileManifest` blocks the UI on large vaults.** A 10 000-file vault used to sit in one giant `Y.Doc.transact` populating the manifest, freezing Obsidian for hundreds of ms and producing one massive update message every peer had to replay. Local→manifest registration is now batched 200 files per transact, with `await setTimeout(0)` between batches so the UI thread can paint and peers can apply updates incrementally.
- **Canvas `updateCanvasFromDisk` ran a redundant diff every save.** It compared the freshly-parsed disk JSON (in disk's key order) to `lastSerialized` (in our sorted-key order) as strings — they always differed even for identical canvases. Removed the (broken) fast-path comparison; `applyCanvasJsonToY` was already idempotent via `diffApplyMap`'s per-value `JSON.stringify` compare, so the diff short-circuits field by field anyway. Also fixed: parse the raw JSON once instead of twice.

### Added
- **`authenticationFailed` handler on the manifest provider.** Per-file providers had this; the manifest provider didn't, so a JWT-rejected manifest stayed silent in the log and the user never found out structure-sync was dead. Now logs an error and shows a `Notice`.

### Minor
- `editorCompartment` marked `readonly`.
- Typo in `attachFile` log: "raced an error" → "errored".

## 0.6.4 — 2026-05-24

Wraps up the follow-ups listed at the end of 0.6.3 plus an admin-side validation fix.

### Added
- **`Debug logging` toggle in settings.** Off by default. When off, the verbose per-keystroke / per-event lines (`[collab] ytext …`, `[collab] editor … changed`, `[collab] reconcile: created …`, `[collab] remote rename/delete/create`, `[collab] disk-sync …`, every `attachFile` step, every binding bind, etc.) are silent. Errors, warnings, the diagnostic command output, plugin-load/unload markers, socket status, manifest-synced and reconcile-complete summaries stay on always. The motivation: those debug lines contain literal note content, and they'd leak into the dev console during a screen-share.

### Fixed
- **`remoteApplyPaths` race**. The set-based suppression flag could be cleared by one flow while another still needed it set — e.g. our 300 ms disk-sync write and a remote rename touching the same path within the same `SUPPRESS_HOLD_MS` window. Replaced with a refcount `Map<path, number>`; `add(path)` increments and the matching `delete(path)` decrements — only when the count reaches 0 does `has(path)` become false. The 20+ call sites are unchanged: an `add` / `delete` / `has` shim preserves the old API while the underlying storage is a `Map`.
- **Redundant binary uploads.** `uploadBinary` rewrote the full bytes into the manifest even when nothing had actually changed. Each rewrite broadcast a fresh full-content `Y.Map.set` to every peer, which rewrote the file on disk, which fired a `modify` event, which called `uploadBinary` again — a stable cycle whenever any tool touched a binary file's mtime. We now byte-compare against the existing value and skip the write if equal.
- **`gen-token` accepts malformed `expiresIn`.** A common mistake: passing `365` (intended as days) is silently treated by `jsonwebtoken` as 365 *seconds* — about six minutes. The script now validates `expiresIn` against `/^\d+(ms|s|m|h|d|w|y)?$/i` up front and refuses to sign on garbage input.

### Notes
- `purgeOldTrash` already removes the corresponding `binaryData["trash:UUID"]` entries in the same transact block (line ~996); the 0.6.3 changelog flagged this as a follow-up but the code review was mistaken — it was already correct.

## 0.6.3 — 2026-05-24

A hardening pass driven by a code review of the whole client + server. The plugin acquired a lot of guard-on-top-of-guard layers across 0.5.x; this release strips out the genuinely faulty patterns and replaces them with proper machinery.

### Fixed
- **`attachFile` race on rapid file switches.** `attachFile` is async and can wait up to 4 seconds for initial sync. When the user switched files quickly, the older call would resume from `await`, see its file still active locally, and clobber the binding the newer call had set up. Each invocation now mints a monotonic `attachToken`, stores it in `latestAttachToken[path]`, and bails before any `editor.dispatch` if a newer attach for the same path has bumped the value.
- **Duplicate `createSession` for the same path.** Obsidian re-fires `file-open` for the same path under several conditions (workspace activation, focus shifts). Two `attachFile` calls would both see `sessions.get(path) === undefined` and race past `createSession`, leaving an orphan `HocuspocusProvider` permanently hooked into the shared socket. Concurrent calls now coalesce through an `attachInFlight: Map<string, Promise<FileSession>>`.
- **Multi-pane binding.** When the user opened the same file in two panes, only the *active* pane's editor got yCollab attached. Typing in the inactive pane went through Obsidian's normal save path, bypassed the CRDT, and got silently overwritten the moment our disk-sync wrote Y.Text back. `attachFile` now walks every leaf with `iterateAllLeaves`, picks out every MarkdownView pointing at this file, and reconfigures the compartment on each editor view.
- **Offline disk-seed loop.** The disk-seed branch (Y.Text empty → fill with disk content) used to run whether or not the provider had successfully synced with the server. If the server was slow to respond (>4s timeout), we'd seed from disk; the server's actual content would arrive afterwards and merge with ours, doubling the document. Now we only seed when `provider.synced === true`. If the server is unreachable after the wait, we leave Y.Text empty and log a clear notice — the editor stays blank until the real content arrives.
- **`ytext.observe` leaks in per-file sessions.** The diagnostic logger and disk-sync observers were anonymous closures with no unobserve on destroy — they stayed in Y.Text's listener arrays forever and held the plugin instance alive through their closures. `FileSession` now carries an `observers` array that `destroySession` walks to call `ytext.unobserve(fn)` for each.
- **Disk-sync timer leak.** The 300 ms `setTimeout` for disk-sync was held in a closure-local variable that nothing cleared on session destroy. A stale write could land after the session was torn down, after the file was deleted, or after the plugin was unloaded. `FileSession` now carries `diskWriteTimer`; `destroySession` flips a `destroyed` flag, clears the timer, and the disk-sync callback rechecks `destroyed` at each await point.
- **Manifest map observers leak.** `manifestMap.observe(...)` and `manifestBinaries.observe(...)` were registered anonymously, with no `unobserve` in `stopVaultSync`. The observers could briefly fire on a torn-down Y.Doc during plugin reload. We now hold typed references to both observer functions and call `unobserve` explicitly before destroying the manifest Y.Doc.

### Notes / known follow-ups (not in this release)
- `remoteApplyPaths` is still a plain `Set<string>` rather than a refcount `Map`. Two concurrent flows suppressing the same path can race — one finishing decrements the flag the other still wants set. In practice this hasn't produced an observed bug, but it's the next thing on the cleanup list.
- `purgeOldTrash` doesn't also remove the corresponding `binaryData["trash:UUID"]` entries explicitly; they're transitively kept around by the (also still-present) trash record, but if the trash map is mutated by a peer without the bytes being mirrored we could leak bytes. Worth tightening.
- The diagnostic `[collab] ytext ROOM …` line dumps every keystroke (including potentially private content) to the dev console. Should sit behind a `debugLogging` setting, off by default.
- The disk-sync write uses a non-refcounted single-element `remoteApplyPaths` suppression; same caveat as item one.

## 0.6.2 — 2026-05-24

### Added
- **Client-version gate on the server.** The plugin now sends its version as a `clientVersion` query parameter on every WebSocket connection. The server's new `onConnect` hook reads it, compares against `MIN_CLIENT_VERSION` (default `0.6.2`, overridable via env var), and refuses connections below that threshold. Older clients can no longer write to the shared CRDT, so they can't corrupt rooms while you test with a current build.

### Fixed
- **Old-content flash on file switch.** Obsidian's auto-save doesn't reliably fire for the editor transactions our binding pushes (they aren't user-driven), so the file on disk would lag behind the real Y.Text state. The next time the user opened the file Obsidian read disk → editor briefly showed stale content → our pre-sync overwrote with Y.Text → user saw a flash on *every* switch (not just the first). The plugin now writes Y.Text to disk itself on a 300 ms debounce, keeping disk and Y.Text equal, so subsequent reopens show the right content immediately.

## 0.6.1 — 2026-05-24

### Fixed
- `EditorView.update are not allowed while an update is in progress` thrown by the new binding. The chain was: sync plugin's `update` method publishes the local cursor with `awareness.setLocalStateField("cursor", ...)` → awareness fires its `change` event synchronously → the decoration plugin's listener tried to `view.dispatch({...})` to trigger a re-render → CodeMirror rejected the dispatch because the original `update` was still on the stack. The listener now defers the dispatch via `setTimeout(0)` (breaking out of the update call stack) and coalesces concurrent change events with a `pending` flag. It also skips entirely when the only client whose awareness changed is the local one — our own cursor isn't rendered locally anyway.

## 0.6.0 — 2026-05-24

### Changed
- **Replaced `y-codemirror.next`'s `yCollab` with our own bidirectional editor ↔ Y.Text binding** (`plugin/src/collab-binding.ts`). The library uses module-level `ViewPlugin` constants (`ySync`, `yRemoteSelections`) which CodeMirror identifies by reference, so swapping the compartment from one file to another reused the old plugin instances — their constructor-cached `this.conf` still pointed at the previous file's Y.Text and Awareness. Obsidian reuses the same `EditorView` across every file in a pane, so this reuse was the common path. Our `createCollabBinding(ytext, awareness)` calls `ViewPlugin.fromClass(...)` on inline classes — every call produces fresh `ViewPlugin` specs, so each compartment reconfigure is a genuine destroy-and-recreate. File switching is now reliable.
- The binding handles editor → Y.Text forwarding, Y.Text → editor application (with a `COLLAB_SYNC` annotation as the loop breaker), local cursor publication to Awareness on selection / focus change, and rendering of remote cursors + selections as CodeMirror decorations. The remote caret widget keeps the same DOM structure as `y-codemirror.next` produced, so `styles.css` (which forces the name label to stay visible) carries over untouched.
- Local cursor is cleared from Awareness when the editor loses focus, so peers stop seeing a stationary cursor when the user navigates away.

### Removed
- `yCollab`, `ySync`, `ySyncFacet`, `yRemoteSelections`, and `YSyncConfig` imports from `y-codemirror.next`. The runtime dependency stays in `package.json` for now in case future undo-manager integration wants it, but the plugin no longer pulls anything from it.
- The 0.5.8 in-place hack that mutated `ySync.conf` and `yRemoteSelections._awareness` after each compartment reconfigure is no longer necessary — the new binding doesn't have the underlying caching problem.

## 0.5.8 — 2026-05-24

### Fixed
- **Switching files no longer wires the editor to the previous file's CRDT.** CodeMirror identifies ViewPlugins by reference, and `y-codemirror.next` re-exports the same `ySync` and `yRemoteSelections` instances on every `yCollab()` call. So even after our two-step `reconfigure([])` → `reconfigure(yCollab)` dance, CM6 could reuse the previous ViewPlugin instances — their constructor-cached `this.conf` kept pointing at the old file's Y.Text and awareness. Typing in file B then forwarded edits into file A's Y.Text, and A's remote cursors landed in B's editor. To work around it we reach into the live instances after the reconfigure dispatches and rewire `this.conf`, the Y.Text observer, and the awareness `change` listener to the current file's facet.
- **Awareness handoff on file switch.** When a user moved from file A to file B, their cursor in A stayed frozen at its last position for every peer still on A. We now clear local awareness on every other open session in `attachFile`, and re-affirm the user's name + color on the session for the active file, so peers see the user actually leave A and appear on B.

## 0.5.7 — 2026-05-24

### Fixed
- **Catastrophic doubling loop introduced in 0.5.6.** The "force-sync editor to Y.Text" step ran *after* yCollab had already attached. ySync.update saw our editor.dispatch as a local edit, converted it into `delete(0, editor.length) + insert(0, ytext.toString())` on the Y.Text, and applied that on top of the existing 40-char content — producing a `delete X chars + insert N chars` operation that the CRDT replayed as content append rather than no-op. Every file switch doubled (or worse) the Y.Text length and broadcast that to peers, who then doubled again. Logs showed Y.Text growing 46 → 175 → 458 → 832 → 1583 → 2577 → 5073 → 10138 characters within seconds.
- The fix re-orders attachFile to: (1) compartment.reconfigure([]) to detach old yCollab, (2) editor.dispatch to align editor with Y.Text content while no ySync is attached, (3) compartment.reconfigure(yCollab(...)) to attach fresh. Because ySync isn't in the state during step 2, the editor rewrite no longer round-trips through Y.Text and no loop forms.

## 0.5.6 — 2026-05-24

### Fixed
- **yCollab is now actually re-bound when you switch files in the same pane.** CodeMirror identifies ViewPlugins by reference, and y-codemirror.next exports the same `ySync` instance every time, so `compartment.reconfigure(yCollab(newYtext, ...))` was reusing the old `ySync` — its cached `this.conf` (containing the *previous* file's Y.Text) survived the reconfigure. The result: typing in shared.md after opening it on top of Хуй утки.md forwarded edits into Хуй утки's Y.Text, and Хуй утки's remote updates were applied to the visible shared.md editor. To force a fresh lifecycle we now dispatch the reconfigure in two hops — `compartment.reconfigure([])` first (which triggers `ySync.destroy()` and unobserves the old Y.Text), then `compartment.reconfigure(yCollab(...))`, which re-runs `ySync.constructor` against the new facet.
- **Editor doc is force-synced to Y.Text on attach.** yCollab does not reconcile editor and Y.Text on construction — if disk content drifted from the shared Y.Text (peer typed while we were offline, or Obsidian re-read the file), they stayed inconsistent. The plugin now treats Y.Text as authoritative and rewrites the editor doc to match it after attaching, with a log line stating the size change.

## 0.5.5 — 2026-05-24

### Fixed
- **Typing in the editor finally reaches Y.Text again.** Since the Phase-2 rewrite we installed each per-file yCollab via `editorView.dispatch({ effects: StateEffect.appendConfig.of(compartment.of(yCollab(...))) })`. With that path the underlying `ySync` ViewPlugin from `y-codemirror.next` never received the editor's `update` calls — the editor still saved to disk through Obsidian's auto-save, but the CRDT never saw any local edits and so remote peers received nothing and never advertised their cursors back. Phase 1 used the same library successfully via a direct `appendConfig.of(yCollab(...))` (no Compartment wrapper), which is the regression boundary.
- The fix moves to Obsidian's official extension API: a single per-plugin `Compartment` is installed on every editor via `this.registerEditorExtension(compartment.of([]))` at plugin load. `attachFile` then dispatches `compartment.reconfigure(yCollab(...))` on the specific editor view, swapping the active binding. This path keeps `ySync` wired into CodeMirror correctly and gives us per-editor reconfiguration for free.
- Removed the legacy per-editor stash on `EditorView` (the `__collabCompartment__` property, owner-identity tracking, manual unload cleanup) — Obsidian's `registerEditorExtension` handles the lifecycle.

## 0.5.4 — 2026-05-24

### Added
- A Y.Text observer in every per-file session prints each change to the console with the kind ("local" vs "remote") and the delta — proves whether typing in the editor actually reaches the CRDT.
- A CodeMirror `EditorView.updateListener` is now installed alongside the yCollab extension and prints every `docChanged` transaction. Lets us tell editor-emits-events apart from yCollab-doesn't-forward-them when something seems "stuck".

## 0.5.3 — 2026-05-24

### Added
- Verbose per-step logging inside `attachFile`. Every code path (skipping, creating session, awaiting sync, seeding from disk, bailing because the active view changed, installing the compartment, rebinding a stale one, reconfiguring) now prints a `[collab] attachFile(<path>): …` line so we can tell from a single log dump whether yCollab actually ended up wired to the editor.
- The diagnostics command now reports whether the *currently active* editor has our compartment attached, which Y.Doc room it's pointing at, and surfaces "yCollab ❌ NOT bound" when something prevented the binding.
- Defensive guard for `view.editor.cm` being absent (Reading-mode views) — the plugin now logs a clear message and skips instead of throwing.

## 0.5.2 — 2026-05-24

### Fixed
- **Edits don't propagate after a plugin reload.** The yCollab `Compartment` we installed on each editor was stashed on the `EditorView` object itself. On plugin unload we destroyed the per-file Y.Docs but never reset that compartment — so when the next plugin instance ran `attachFile`, it saw `holder.activeRoom === targetRoom`, returned early, and the editor stayed bound to the dead Y.Doc from the previous instance. Background providers reported `synced` but the user saw nothing change and remote cursors never appeared. Now each `CompartmentHolder` records which plugin instance installed it via an `owner` identity; a holder owned by a previous instance is detected on next `attachFile` and reconfigured to the live extension. We also detach yCollab on `onunload` for every open markdown view to leave the editor in a clean state.

## 0.5.1 — 2026-05-24

### Fixed
- **Opening a populated file no longer empties it.** `attachFile` used to bind `yCollab` to the editor immediately after creating a fresh session — when the Y.Text was still empty, yCollab cleared the editor with that empty state, Obsidian auto-saved the cleared buffer, and the file's content was destroyed on disk. The fix waits for either the IndexedDB local cache or the first server sync (with a 4-second safety timeout) before binding; if Y.Text is still empty after that, seed it from disk in a single insert, *then* attach yCollab.
- Removed the redundant `provider.on("synced", ...)` disk-seed inside `createSession` so we don't risk double-seeding (which would have concatenated two copies of the file).
- `reconcileManifest` now logs the final manifest and trash counts after it finishes, so `[collab] manifest synced (N entries)` no longer looks misleading when reconcile adds more.

## 0.5.0 — 2026-05-24

### Changed
- **Canvas sync is now structural.** Every `.canvas` file gets a `Y.Map<id, Y.Map<field, value>>` per node and per edge plus a `meta` map for any top-level extras. Local saves are diffed against the Y.Doc so the CRDT history records only what changed; remote updates are serialised back to JSON with sorted ids for deterministic output. **Concurrent edits to different nodes merge cleanly and the file on disk is guaranteed to parse** — no more "broken JSON" failure mode. Same-node concurrent edits still resolve last-writer-wins at the field level (no garbage), which matches how Figma-style multiplayer behaves on conflicting drags.
- **`.base` sync is atomic.** Each save replaces the entire file content as a single string in a `Y.Map`. There is no character-level merge, so simultaneous edits to a base resolve to whoever saved last — but the resulting file is always valid YAML because we never write a partial document. Reasonable for base files which are typically maintained by one person at a time.
- New `EntryKind` values: `"canvas"` (structural) and `"text"` (atomic). Old `"text"` entries created by 0.4.0 still load — they're just upgraded to the new code paths once the file is touched.

### Added
- Invited `mikedizhur` as a write-access collaborator on the GitHub repository.

## 0.4.0 — 2026-05-24

### Added
- **Soft delete with a 30-day trash.** Deleting a file now moves its manifest entry into a `trash` map with a UUID and timestamp; the bytes of binary deletions are preserved under a `trash:UUID` key. Any client that connects after the retention window expires permanently purges old entries. A new command **"Collab: Show deleted files (trash)"** opens a modal listing every soft-deleted entry with a one-click Restore. Restoring back to an occupied path appends " (restored)" to avoid clobbering.
- **Real-time sync for `.canvas` and `.base`.** These files no longer go through the binary channel — they now live as per-file `Y.Text` sessions whose content mirrors the file on disk. Each save is replaced into the shared `Y.Text` in a single transaction; remote changes are written straight back to the file with the existing loop-suppression hold.
- New `EntryKind: "text"` for non-markdown files we want to fully sync. Extending the set is one line: add the extension to `TEXT_EXTENSIONS`.

### Notes
- Y.Text for `.canvas` / `.base` is character-level CRDT, so simultaneous edits to *different* parts of the file merge cleanly. Simultaneous edits to the *same* node can occasionally produce broken JSON — Obsidian will show a parse error and the affected user can fix it by hand. Structural per-node merging is a planned follow-up.

## 0.3.0 — 2026-05-24

### Added
- **Empty folders sync.** Creating a folder with no files inside now propagates to every connected vault. Manifest entries carry a `kind` of `"file" | "folder" | "binary"`.
- **Binary attachments sync (images, PDFs, etc.).** Non-markdown files are tracked in the manifest with their bytes stored in a parallel `binaryData` Y.Map (`path → Uint8Array`). On local create the bytes are uploaded; on remote create or modify, peers write the bytes to their local vault via `vault.createBinary` / `modifyBinary`. Rename moves both the manifest entry and the bytes in a single transaction so embeds keep resolving.
- Files larger than 25 MB are skipped with a notice — Yjs is a poor transport for huge blobs and we don't want a runaway PDF to choke the manifest.
- `.obsidian/` configuration directory and the vault root are explicitly excluded from the manifest.

### Changed
- Reconcile now walks the full vault tree (files + folders), not just markdown files, and registers every entry it finds.
- Delete also removes any associated binary data from the manifest.

## 0.2.0 — 2026-05-24

### Added
- **Vault structure sync.** A single shared `vault:manifest` Y.Doc holds the set of markdown files in the vault. Every client mirrors local create / delete / rename into the manifest, and applies remote manifest changes back to its local vault — so renaming `foo.md` to `bar.md` (or moving it into a folder, or deleting it) propagates to everyone. Folders are created implicitly on the receiving side when a remote file path requires them.
- Single-delete-plus-single-add inside one Y transaction is recognised as a rename and applied via `fileManager.renameFile`, preserving file contents and existing per-file sessions. Other shapes fall through to plain create / delete.
- On initial connect after offline, the manifest reconciles with the local vault — missing local files are created empty, and any local files not yet in the manifest are registered.

### Notes
- Manifest tracks markdown files only. Binary attachments (images, PDFs) still need a separate channel like Syncthing or LiveSync if you want them mirrored across machines.

## 0.1.1 — 2026-05-24

### Fixed
- Display name / color changes in settings now propagate to all active sessions immediately; previously the new value only applied to sessions opened after the change.

### Added
- Verbose connection logging: socket status (`[collab] socket status: ...`), per-room status, per-room sync, and authentication failures are all printed to the dev console.
- New command **"Collab: Show connection status (diagnostics)"** — prints a snapshot of the socket state, every active session, its room name, peer count, and document length. Useful when "nothing is syncing" and we need to see what's actually attached.

## 0.1.0 — 2026-05-24

First usable release. Covers the full Phase 0–6 roadmap.

### Added
- Realtime collaborative editing for every markdown file in a vault, one Yjs room per file path.
- Hocuspocus server with SQLite persistence, deployable via systemd on any Linux box (current deploy: `ws://158.255.5.243:1234`).
- Always-visible name labels above remote carets (via styles.css overriding y-codemirror.next's hover-only base theme).
- Translucent selection highlights in each user's color.
- Per-user display name and color, with native Obsidian color picker in the settings tab.
- Offline persistence via `y-indexeddb` — edits made while disconnected replay on reconnect.
- Optional JWT authentication; server runs in unauthenticated mode if `JWT_SECRET` is not set.
- `gen-token` script for issuing JWTs to teammates.
- Status bar indicator (🟢 live / 🔴 offline).

### Fixed
- Providers attach explicitly to the shared `HocuspocusProviderWebsocket`, otherwise sync and awareness silently never start.
- WebSocket status events listen for `status` (the actual emitted event), not the imagined `connect` / `disconnect`.
- Compartment install + extension reconfigure now happen in a single dispatch.
- Plugin runtime settings (`plugin/data.json`) excluded from the repo.

## 0.0.1 — 2026-05-23

Initial scaffolding and proof-of-life sync of a single hardcoded file.
