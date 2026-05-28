# Changelog

All notable changes are recorded here. The project loosely follows [Semantic Versioning](https://semver.org/) — patch bumps for fixes, minor for features, major for breaking changes.

## 2.0.3 — 2026-05-27

### Fixed
- **Mobile WebView ghost-cursor labels: real fix this time.** v2.0.2's `eq() → false` change forced CodeMirror to recreate the widget DOM on every decoration update, but iOS/Android WebView still left the old paint behind. Cause is at the rendering layer, not the DOM layer: when an `absolutely-positioned` descendant of a `contenteditable` element gets removed from the DOM, mobile WebView frequently leaves the painted pixels on screen until the surrounding region is forced to repaint. The DOM truly is gone; only the cached rasterization sticks. Fix: force a GPU compositor layer on both `.cm-ySelectionInfo` and `.cm-ySelectionCaret` via `transform: translateZ(0)` (plus `-webkit-` prefix and `backface-visibility: hidden` for the label). Composited layers get cleanly disposed when their backing DOM is removed, so the stale paint can't survive. This is a well-known workaround for iOS Safari contenteditable artefacts.

## 2.0.2 — 2026-05-27

### Fixed
- **Peer cursor labels left as ghost copies on iOS / Android WebView when the peer moved fast.** Caused by `YRemoteCaretWidget.eq()` returning true when color + name matched — which is always, for the same peer. CodeMirror treats two `eq`-equal widgets across decoration rebuilds as "same widget, just reposition the existing DOM", and on mobile WebView the reposition of an `absolute`-positioned label inside a `transform`-ed parent leaves the previous render painted at the old coordinates. User report shows two `leonestis` labels visible at positions the peer occupied seconds earlier, while the actual caret is somewhere else. Fix: `eq()` now returns `false` unconditionally, forcing CodeMirror to tear down the old widget DOM and create a fresh one on every decoration rebuild. Costs a few extra DOM operations per cursor move — imperceptible compared to the ghosting. Desktop unaffected (it handles the reposition correctly either way, but the recreate path is fine there too).

## 2.0.1 — 2026-05-27

### Fixed
- **`RangeError: Mark decorations may not be empty` from peer selections crashed the entire decoration build.** When a peer's multi-line selection started exactly at end-of-line (or ended exactly at start-of-line), the first-line / last-line mark decoration we built was zero-length and CodeMirror rejected the whole `Decoration.set` call. Effect: every peer's cursor on screen froze in place, and on mobile WebView the half-rendered CSS lingered as ghost fragments across line breaks until the next clean rebuild. Now we guard each pair against `from === to` and the per-peer build is also wrapped in try/catch so one bad state can't poison every other peer's rendering. Decoration.set itself also wrapped — if sort/identity ever throws we return an empty set instead of cascading the error into the editor update.
- **`session attach: gave up after retries` storm when LiveViewManager fired multiple refreshes in a row.** The SessionManager state machine polled every 25 ms with a 4-iteration budget (100 ms total) when it saw the path already in `attaching` state. `TextSession.create` waits up to 4 s for provider sync, so any moderately slow connection blew the budget and `attach()` returned null. LiveViewManager then re-queued and re-burned the budget on its next refresh, and the cycle repeated — visible as 3+ "gave up" warnings before the original startAttach finally settled. Fixed by switching the state machine to **promise-based serialisation**: the `attaching` state now carries the in-flight attach Promise, and concurrent attach() callers for the same docId await it directly. No polling, no retry budget, no spurious nulls. Different-docId callers still abort + await + restart, also without polling.

## 2.0.0 — 2026-05-27

The first major change to markdown sync since v1.0.0. After 25 patch releases on top of the v1.0 codebase, the editor binding pipeline was still leaking: peers' cursors would silently vanish after a few file switches, the `editor↔ytext compartment empty` log line still showed up under view recycling, and Bug 2 in v1.0.5 had to ship a special-case "re-publish cursor on idempotent rebind" hack just to keep the active file's cursor visible. The root cause was structural — `y-codemirror.next`'s upstream `ySync` captures `ytext` and `awareness` in the constructor of a module-level `ViewPlugin.fromClass(...)` instance, and CodeMirror's plugin-identity model means swapping a compartment with the same plugin constant doesn't rebuild the instance. v1.x worked around this by minting fresh `ViewPlugin.fromClass(...)` constants on every rebind (see the pre-2.0 `collab-binding.ts`), but every rebind tore down the awareness observer for one tick during which any awareness event was silently dropped. That one tick is the bug.

v2.0.0 adopts the architecture used by [No-Instructions/Relay](https://github.com/No-Instructions/Relay) (MIT) for the same problem in their Obsidian plugin: the ViewPlugin instance is intentionally stable across file switches, and the Y.Text / Awareness it talks to are resolved dynamically on every observer body and every `update()` cycle via a Facet-injected `resolveContext(view)` function. A single-flight `LiveViewManager` owns the workspace ↔ session mapping and orchestrates per-leaf `LiveView` lifetimes; a `LocalPresenceController` is the only place in the plugin that writes to awareness `setLocalState`, so the "peer invisible" class of bugs is impossible by construction.

### Breaking

- **Plugin requires server v2.0.0+.** The server's `MIN_CLIENT_VERSION` is now `"2.0.0"`. Older clients are hard-rejected at WebSocket connect with `client version X is too old`. The wire protocol (`PROTOCOL_VERSION = 2`) is unchanged; the bump is to prevent old clients with the freshly-minted-ViewPlugin trick from running against newer peers, because their "ghost cursor for one tick on every rebind" state would still leak through to peers' awareness maps. Either upgrade every client to 2.0.0 first or keep the server pinned at 1.x for the duration of the rollout — there's no compat shim.
- **`collab-binding.ts` is gone.** Anything importing `createCollabBinding` or `COLLAB_SYNC` from that path needs to migrate to `yedit/y-collab.ts` (`yCollab(resolveContext)`) and `yedit/y-sync.ts` (`ySyncAnnotation`). The plugin doesn't expose these externally, so this is only relevant if you were patching the plugin in-tree.
- **`SessionManager` lost its editor-binding methods.** Anything that was calling `bindEditorIfReady`, `bindOpenEditorsFor`, `clearEditorBindingFor`, `publishLocalCursor`, or `awarenessHandoffTo` against the manager has to route through `LiveViewManager` + `LocalPresenceController` instead. These were all private surfaces inside main.ts / manifest-sync.ts in v1.x; external consumers shouldn't notice. The public state machine (`attach`, `detach`, `handleRename`, `isActive`, `getBound`, `destroyAll`, `describe`) is unchanged.
- **`TextSession.create` no longer seeds `user` into the session's awareness.** That writes goes through `LocalPresenceController` now (which broadcasts on every `sessionReady` / focus change / settings change). If you were reaching into a `TextSession` to mutate `provider.awareness.setLocalStateField("user", ...)` directly, stop — it'll be clobbered by the next presence broadcast.

### Changed

- **Vendored `y-codemirror.next` as `plugin/src/yedit/`.** Three files: `y-sync.ts` (editor↔Y.Text), `y-remote-selections.ts` (awareness → caret/selection decorations + local cursor publish), `y-collab.ts` (top-level export). MIT-licensed; LICENSE files for both upstream (Kevin Jahns) and Relay (No-Instructions) are in the directory. The fork's only structural change vs upstream: `ytext` and `awareness` are NOT captured in the constructor — instead a `ResolveContext` function is read from a Facet on every callback. If it returns `null` or `{ active: false }`, every plugin body short-circuits to a no-op. If it returns a new `docId`, the plugins unobserve the previous Y.Text, call `removeAwarenessStates(prev, [clientID], 'switch')` so peers see our cursor disappear from the old file immediately, and re-observe the new Y.Text. Reconciliation on rebind uses `diff-match-patch` so the editor's caret + undo stack survive a binding swap. The upstream `yjs/y-codemirror.next#19` "facet caching" bug — never fixed upstream — is structurally bypassed.
- **New `LiveViewManager` (`plugin/src/live-view-manager.ts`).** Single-flight refresh queue (subsequent events during an in-flight refresh coalesce into ONE additional pass after). Subscribes to `workspace.on("layout-change" | "file-open" | "active-leaf-change")`, `vault.on("rename" | "delete")`, and `ManifestSync.onSessionReady`. On every refresh: builds the desired set of `LiveView` instances (one per markdown leaf whose file has a manifest entry), diffs against the current set, releases stale, attaches new, leaves matching alone with `.path` updated. Each `LiveView` owns one `Compartment` and one EditorView's binding lifetime; `attach()` reconfigures with `yCollab(resolveContext)`, `release()` flips `active=false` so resolveContext returns inert, `detach()` reconfigures to `[]` for terminal teardown. Connection pool stub is in place (`// TODO Phase 7: cap at BACKGROUND_CONNECTIONS=3`) — v2.0.0 keeps all bound sessions connected.
- **New `LocalPresenceController` (`plugin/src/local-presence.ts`).** Single source of truth for awareness state across every bound markdown session. Exposes `setUser({name, color})` and `setCurrentPath(path | null)`. On any change, iterates `SessionManager.boundMarkdownSessions()` and writes a full state object via `awareness.setLocalState({user, cursor: lastCursor or null})` per session — the current path gets the cursor, every other path gets `cursor: null`. `setLocalState` (NOT `setLocalStateField`) is used deliberately so the awareness observer fires unconditionally on every broadcast; that's how a peer's view of "A returned to this file" updates without a focus-loss/focus-gain dance.
- **`ManifestSync.onSessionReady(cb)` event emitter.** Fires whenever `SessionManager` transitions a path into the `bound` state. `LiveViewManager` subscribes and queues a refresh, which is how a session created during `reconcile` (e.g. a peer's file just materialised) reliably gets bound to the leaf that's already showing it. Replaces the v1.x `.then(bindEditorIfReady)` chain in `onLocalCreate`.
- **`SessionManager` is now session lifecycle only.** Editor binding moved entirely to `LiveViewManager`; awareness writes moved entirely to `LocalPresenceController`. The state machine (`detached | attaching | bound | tearing-down`) and the abort-on-supersede semantics are unchanged. New helper `boundMarkdownSessions()` is an iterator the presence controller consumes.
- **Each LiveView holds its own per-leaf `Compartment`.** v1.x mounted a single plugin-wide `Compartment` via `registerEditorExtension` and reconfigured it for whatever file was currently active. That coupled every editor in the workspace to one binding state. v2.0.0's per-leaf compartments mean two side-by-side editors can each be bound to different sessions independently.

### Fixed

- **Friend's cursor reliably appears when they enter a file, reliably disappears when they leave.** Cursor removal is now a broadcast (`removeAwarenessStates(prevAwareness, [clientID], 'switch')` on rebind + `'destroy'` on `TextSession.destroy`), not a heartbeat-timeout. Peers see the cursor vanish on the same tick A switches files.
- **Friend's cursor is visible in EVERY file they enter, not "invisible everywhere" after a few switches.** The structural fix: every focus change runs `LocalPresenceController.setCurrentPath(newPath)`, which writes a full `{user, cursor}` state object into the current session's awareness AND a `{user, cursor: null}` object into every other bound session. Full-object `setLocalState` always fires the awareness observer; remote peers' `change` callbacks rebuild decorations against the latest state on the same tick. No more "I rebound but the publish failed so my cursor is null in every room".
- **Editor binding survives rapid file-switching / rename storms / Obsidian view recycling.** The same ViewPlugin instance handles every file switch; only its internal "what session am I bound to" state changes. CodeMirror's identity model — which v1.x fought by minting fresh plugin instances — now works with us instead of against us.
- **The "compartment empty" / "ytext.length=44 but disk-sync wrote 63 chars" diagnostic class of error is structurally impossible.** Both came from cases where the editor's compartment was reconfigured to `[]` (clearing the binding) but the disk-sync observer kept running. v2.0.0's release path doesn't reconfigure to `[]` — it flips `active=false` and lets the (now inert) plugin instance stay in the compartment. The Y.Text observer is unobserved inside `y-sync.ts` itself on a real rebind, so the disk-sync observer for the OLD session can't fire against the NEW session's editor state.
- **Exactly ONE `LiveView.attach` log line per file open.** No more double-bind from `attach()` + `bindEditorIfReady`; LiveViewManager is the single binder.

### Notes

- **Conflict files (`*.conflict-<ISO>.md`) are no longer created.** v1.0.5 introduced them as a safety net before letting the parity check overwrite the editor; under view recycling they were a false-positive factory (the editor briefly held disk content while ytext was syncing, the diff was misread as user-vs-server conflict). v2.0.0's binding reconcile uses diff-match-patch on rebind so the editor's caret + undo stack are preserved on the common cases; on a true ytext-vs-editor divergence the parity check still resyncs the editor to ytext (matching v0.9.2 behaviour) but doesn't save a `.conflict-*.md`. Phase 3 (next release) introduces a real disk buffer + 3-way merge to bring conflict detection back without the false positives.
- **The "first peer on this file" seed-ytext-from-editor case is preserved.** Inside `yedit/y-sync.ts`'s rebind path: if `ytext.length === 0` and the editor has content, we insert the editor content into ytext (single transaction, origin=`this` so the observer doesn't echo). This keeps the v1.0.5 behaviour for the very common case of opening a file before any peer has touched its session.
- **Mobile connection pool is still Phase 7 work.** v2.0.0 connects every bound markdown session — fine on desktop, can be heavy on mobile with a large vault. A `// TODO Phase 7: cap at BACKGROUND_CONNECTIONS=3` stub lives in `live-view-manager.ts`.
- **Canvas presence (`canvas-cursors.ts` + `canvas-session.ts`) and the wire protocol are unchanged.** Both are explicitly outside the v2.0.0 surface; they didn't have the structural issue this release fixes.
- **`y-codemirror.next` npm dependency removed.** No source file imports it anymore — `yedit/` is the fork. The MIT licenses for the upstream and Relay's fork are reproduced verbatim under `plugin/src/yedit/LICENSE.{upstream,relay}`.
- **`diff-match-patch` added as a runtime dependency** (with `@types/diff-match-patch` as dev). Used inside `yedit/y-sync.ts` for the reconcile-on-rebind path and the parity-check resync path.

## 1.0.5 — 2026-05-27

A hardening pass on the markdown sync path. v1.0.4 fixed the file-open auto-attach regression, but exposed three latent issues that all manifested as "the editor binds, but presence and content sync misbehave on subsequent file switches." Diagnosed from a single user log showing a duplicate `bindOne` line on every open and a `disk-sync … wrote 63 chars` immediately after a `bindOne: … → ytext.length=44`.

### Fixed

- **Bug 1 — double `bindOne` on file-open caused awareness drops.** `SessionManager.attach()` at the end of its bound transition was calling `bindOpenEditorsFor(path)` for `kind === "file"`, then `main.ts`'s `handleMarkdownFileOpen` called `bindEditorIfReady` which ALSO called `bindOpenEditorsFor`. Both reconfigured the editor's compartment with the same binding back-to-back. CodeMirror destroys the first ViewPlugin instance *between* the two reconfigures — that destroy unhooks the decorationsPlugin's `awareness.on("change")` listener. Any awareness update that arrived in the gap (one tick or so) was silently dropped. The fix removes the auto-bind from `attach()` and makes the file-open path the single binder. Other `attach()` callers (manifest-sync reconcile, `onLocalCreate`, `onLocalModify`, `applyRemoteRename → handleRename`) cover canvas / atomic-text sessions or never need an editor binding. `onLocalCreate` for local markdown creation now explicitly chains a `bindEditorIfReady` after attach via `.then(...)` so the (vault.create vs workspace.file-open) event-order race never leaves the editor unbound. After the fix, opening any markdown file produces exactly ONE `bindOne` log line per real transition. `bindOne` also got an idempotency check: if the editor is already bound to this path, skip the reconfigure but still re-publish the cursor (see Bug 2).
- **Bug 2 — cursor not re-published when returning to a previously-visited file.** `awarenessHandoffTo(path)` nulls the local awareness state on every OTHER bound session when the user switches files. That's correct for the "I've left this file" semantics — peers should stop seeing our cursor in the file we just left. The wrong half of the symmetry was the return path: when the user came BACK to a file, the new decorationsPlugin would read awareness, find our own state in the local map still nulled, and never render us; the collab-binding's own publish path inside `update()` only fires on `update.selectionSet || update.docChanged || update.focusChanged` AND `hasFocus`. If Obsidian's view recycling kept focus across the switch (it usually does), `focusChanged` doesn't fire, and unless the user moved the caret or typed, the cursor stayed null. Peers never saw us return. Fix: after `compartment.reconfigure` installs the binding in `bindOne`, eagerly publish `user` + `cursor` into the new session's awareness using `Y.createRelativePositionFromTypeIndex` on the editor's current selection. Also published on idempotent re-binds (rapid focus shifts) so a brief handoff blip doesn't strand us. The cursor relative-positions clamp safely against ytext bounds, so even in the Bug-3 conflict case where the editor and ytext disagree at this point, the published position remains valid.
- **Bug 3 — disk content silently overwritten when ytext is shorter than disk.** The legacy `bindOne` pre-sync unconditionally replaced the editor's content with `ytext.toString()` if the two differed, on the assumption that ytext was always authoritative. That assumption breaks when the user edited the file offline / via another tool while the plugin was disconnected: disk grew past the synced ytext state. On reconnect, ytext came back at its earlier merged length (44 chars say), the editor opened showing 63 chars from disk, the pre-sync replaced the editor with the 44-char ytext — **silently destroying the unsynced 19 chars**. The collab-binding's parity check fires the same destructive replacement on the very next update if the pre-sync missed; the editor → ytext push path could win the race sometimes (which is what the user's log showed — `disk-sync … wrote 63 chars` right after `bindOne: → ytext.length=44`, meaning the editor's 63-char content made it INTO ytext via the syncPlugin before the parity check could overwrite the editor), but it's race-dependent and the data loss path WILL fire in some configurations. The new `TextSession.reconcileEditorAndYtext`, called from `bindOne` BEFORE the compartment is reconfigured, distinguishes four cases:
  - editor === ytext → no-op (the common path).
  - ytext is empty, editor has content → seed ytext from editor (the "first peer on this file" path; the old `create()`-time seed-from-disk hook moved here so it can use the editor's actual current content including unsaved keystrokes, not the lagging disk content).
  - editor is empty, ytext has content → no-op here; the binding's parity check correctly dispatches ytext into the editor on the first update.
  - both differ, both non-empty → **TRUE CONFLICT.** Save the editor's content to a sibling `<path>.conflict-<ISO timestamp>.md` via `vault.create` BEFORE the parity check fires. Notice the user with both file paths. The conflict file goes through the normal manifest-sync path so peers also receive a copy. The parity check on the next update cycle replaces the editor with ytext content — but the user's unsynced edits are preserved on disk. NEVER LOSE USER DATA.
- **Audit B — `awarenessHandoffTo` was nulling the entire local state, not just the cursor.** The previous code did `awareness.setLocalState(null)`, which wiped the `user` field too. When we returned to the file (Bug 2 fix above re-published it), peers would briefly see an anonymous cursor label between the awareness clear and the re-publish. Now only `cursor` is nulled; `user` identity persists across handoffs so the name + color label is always there when our cursor reappears.
- **Audit F — atomic-text session destroy now clears awareness state.** `TextSession.destroy` already called `awareness.setLocalState(null)` + `removeAwarenessStates(...)` so peers see our presence vanish on file-delete / plugin-unload. `AtomicTextSession.destroy` was missing the equivalent; added it for consistency. `CanvasSession` is untouched per the v1.0 canvas-frozen contract; its awareness destruction is implicit through `provider.destroy()` which is sufficient for the canvas-cursors layer.

### Audited but not changed

- **Audit A** — per-session user field. Each `TextSession` / `CanvasSession` / `AtomicTextSession` constructor already sets `awareness.setLocalStateField("user", opts.user)`. After Bug 2's fix, `bindOne` re-affirms it on every bind (including idempotent ones). Display-name / color settings changes mid-session don't propagate to existing sessions' awareness — that capability existed in v0.1.1 and got dropped in v1.0.0's rewrite. Deferred to a future release; the workaround is "Reconnect to server" which rebuilds all sessions with fresh user fields.
- **Audit C** — `editorBoundPath` WeakMap staleness. The map can hold an `EditorView → oldPath` entry after a rename or after Obsidian recycles a view to display a different file. `bindOne`'s idempotency check (Bug 1 fix) compares against the current path, so a stale entry pointing at the previous path correctly triggers a full re-bind. Verified through mental walk-through of rename and view-recycle flows.
- **Audit E** — disk-sync echo. `disk-sync` writes ytext content to disk via `vault.modify`, which fires Obsidian's `modify` event. Our `onLocalModify` handler returns early for `.md` extensions (`if (file.extension === "md") return;`), so the event doesn't loop back into the manifest. Obsidian's `vault.modify` doesn't push back into open editors either — the editor's CodeMirror state is the source of truth, vault.modify only touches the on-disk representation. Confirmed unchanged from v1.0.4.
- **Audit G** — cursor coords after content replacement. After `reconcileEditorAndYtext` saves a conflict file, the editor still holds the longer pre-conflict content at the moment `publishLocalCursor` runs. The cursor's relative position is computed against ytext, not the editor, via `Y.createRelativePositionFromTypeIndex(ytext, sel.anchor)` — and `createRelativePositionFromTypeIndex` clamps an out-of-range index to the type's length. So the published position stays valid after the parity check replaces the editor with the shorter ytext content on the next update. Worst case: cursor lands at end-of-document. User-correctable.

### Notes

- The double-bind in v1.0.4 (Bug 1) was a side-effect of v1.0.4's narrow fix scope — the file-open handler was added to drive markdown attach, but the auto-bind inside `attach()` was left in place for the canvas / reconcile paths that historically called `attach` without going through file-open. The right thing to do — make `attach` not auto-bind and let the editor-bind responsibility live entirely on the bind path — wasn't visible until v1.0.4's log surfaced the duplicate.
- `collab-binding.ts` is unchanged. The 0.9.2 parity check is what catches Bug 3's "editor replaces with ytext" overwrite; Bug 3 isn't a parity-check bug, it's a "we never gave the user the chance to keep their disk-edits" bug — the parity check is doing its job (force the editor to match ytext when they diverge), we just need to capture the disk-edits before that happens. The fix sits in `session-manager.ts` + `text-session.ts`, in front of the binding.
- The `.conflict-*` files propagate to peers like any other markdown file (fresh UUID, fresh Y.Doc room). Both peers end up with a copy, which lets the user compare. If this becomes noisy, a v1.1 follow-up could filter `.conflict-*` from manifest propagation; for v1.0.5 the chatty-but-correct behaviour wins.
- Server is unchanged. `MIN_CLIENT_VERSION` stays at 1.0.0; v1.0.5 interops with v1.0.x clients trivially since none of the wire formats changed.

## 1.0.4 — 2026-05-27

### Fixed
- **Markdown sessions never auto-attached on file-open for peer-created files.** When a peer created `Notes.md`, the manifest observer materialised an empty file on disk via `vault.create` but never opened a `SessionManager` session — the reconcile materialise-loop and the "already on disk" branch both explicitly skip `attach` for `kind === "file"` with a comment claiming "session attach happens on file-open." But the file-open handler was calling `sessionManager.bindEditorIfReady(path)`, which is a no-op when the session is detached: it only binds editor views when the path's state is already `bound:file`. Result: opening any markdown file that came in via the manifest (i.e. anything from another peer, or anything at all after a fresh restart since reconcile never attaches markdown) left the CodeMirror compartment empty. The user would type and nothing reached Y.Text — zero ytext delta logs, zero peer sync, silent desync. Fix: file-open now calls a new `handleMarkdownFileOpen` that looks up the manifest entry via `ManifestSync.getEntry(path)`, calls `sessionManager.attach(path, "file", entry.id)` if the entry exists, then runs `bindEditorIfReady` + `awarenessHandoffTo`. `attach()` is already idempotent for the same path+docId so calling it on every open is safe; brand-new files (not yet in manifest) bail out and let `onLocalCreate` handle the registration. Closes the regression introduced by 1.0.0's structural rewrite of the session lifecycle.

### Added
- **Colored console logger (`plugin/src/logger.ts`).** Replaces the `[collab]` prefix on most console calls with a colored subsystem pill: `sync` (blue), `session` (green), `binding` (orange), `blob` (purple), `socket` (cyan), `trash` (brown), `diag` (blue-gray), `plugin` (gray). Same content, way easier to skim a busy log — readers can pick out which subsystem is talking at a glance instead of squinting at line prefixes. The `debugLogging` setting still gates noisy per-keystroke lines through the existing `deps.debug` callback (unchanged contract — the callback in `main.ts` just calls `console.log` when gated open). Canvas modules (`canvas-cursors.ts`, `canvas-session.ts`) stay on plain `console.*` per the v1.0 canvas-untouchable contract; `collab-binding.ts` similarly unchanged.

## 1.0.3 — 2026-05-27

### Fixed
- **`materialise failed for <file> Error: File already exists.` noise on every reconcile.** When a manifest entry's path is already a real local file, `materialise` is supposed to be a no-op. It did `getAbstractFileByPath` first and only called `vault.create` if that returned null, but the check loses the race in two real scenarios: (1) the manifest's `add` observer fires for entries that arrived through IndexedDB persistence loading microseconds before Obsidian's in-memory file cache catches up to its own disk state, and (2) the underlying filesystem is case-insensitive (macOS by default) so a manifest path `test2.md` finds no TFile while the on-disk `Test2.md` makes the create reject. Either way it was a benign duplicate, logged as a real error at `console.warn`. Fix: materialise now (a) returns early if the existing path is a TFile, (b) returns early on a TFolder collision with a clear "path collision" warn instead of a generic create error, and (c) catches any remaining `File already exists` reject from `vault.create` / `vault.createBinary` and drops it as a debug log. Same treatment for the binary path. The reconcile-time spam is gone.
- **Binary materialisation when local file exists but hash differs.** Previously `materialiseBinary` did `if (!exists) createBinary` — meaning if a peer updated a binary while we had the old version cached locally, we'd silently keep the stale bytes. Now we hash the local file; if it matches the manifest hash we no-op, otherwise we `modifyBinary` with the freshly downloaded bytes. Closes the obvious "binary changed but never propagated" hole.
- **Folder vs file path collisions across peers.** If the manifest says a path is a file but the local vault has a folder there (or vice versa), `materialise` used to throw a generic error and log it as a warn. Now it detects the kind mismatch, logs a clear "path collision" message, and skips — no crash, no spurious "File already exists" stack.
- **Connect attempts with empty `serverUrl` produced cryptic socket errors instead of useful UX.** Fresh installs that never opened the settings tab would hit `connect()` on layoutReady and Hocuspocus would try to open `ws://?clientVersion=…`, blowing up in the WebSocket constructor. Now `connect()` short-circuits with a Notice telling the user to set the server URL in settings; no socket is opened until they do.
- **Reconcile is now serialised against itself.** The provider's `synced` event can fire more than once (initial sync, reconnect after dropout); a second `reconcile()` running in parallel with the first would build its `localPaths` snapshot mid-write and pick up false negatives. Calls now chain via a single in-flight promise — the second pass starts only after the first finishes, so its snapshot reflects everything the first one created.

### Changed
- **Binary client surfaces 401 / 403 as a one-shot `Notice` instead of silent retries.** New `BlobAuthError` subclass; on the first auth failure per client instance we toast "Collab blob server rejected the auth token (401). Binary file sync is paused — refresh your Auth token, then reconnect." Subsequent failures in the same session are throw-only — one Notice is enough, ten is spam. Token refresh via the settings tab automatically constructs a fresh client and resets the suppression.

### Notes
- **Things audited but left alone in this pass:** the editor↔Y.Text parity check + RangeError force-resync (0.9.1 / 0.9.2) are still active in `collab-binding.ts`; the file is byte-identical to the 0.9.x version per the 1.0.0 rewrite contract. `purgeOldTrash` is still called from `reconcile`, which now runs at least once per `synced`. `SessionManager` per-path serialization via the `byPath` state machine plus the abort-controller-driven `attaching → tearing-down` transitions remain the source of truth. Canvas presence (`canvas-cursors.ts` / `canvas-session.ts`) is untouched per the task brief.
- **Deferred to v1.1:**
  - Exponential-backoff retry in `BinaryClient` for transient network failures. Currently one failure → manifest entry stays without bytes locally until the next reconcile.
  - Chunked / streaming binary upload from the plugin side. We still buffer the whole file in renderer memory via `vault.readBinary`. Multi-hundred-MB files will pressure RAM but won't OOM the server (the server side streams via `pipeline()`).
  - Download hash verification (sha256 the bytes off the wire, reject on mismatch). Defended on the server side (PUT-time hashing); MITM / disk-corruption defense on read is nice-to-have, not urgent for a self-hosted single-tenant deploy.
  - Orphaned per-file Y.Doc room cleanup when two peers create different UUIDs at the same path while disconnected (the "losing" UUID's room sits on the server forever as ghost data). Same v1.1 GC walker that handles binary blobs will sweep these.
- **Server is unchanged** beyond the post-1.0.0 blob-handler hotfix (3151d3d). `MIN_CLIENT_VERSION` stays at 1.0.0 so the 1.0.2 client keeps working alongside 1.0.3 during rolling upgrades. The httpServer-listener wrapper warns if Hocuspocus internals ever start attaching more than one listener; the warn is still a one-liner — no defensive multi-listener handling needed until that warning actually fires somewhere.

## 1.0.2 — 2026-05-27

### Fixed
- **Plugin crashed on first load with `Cannot read properties of undefined (reading 'setServerUrl')`.** Initialization order in `onload` was: `await loadSettings()` (which internally calls `saveSettings()`) THEN construct `statusBar` and `binaryClient`. But `saveSettings()` touches both. On every fresh load the first call to `saveSettings()` threw before either was constructed, the load aborted, then `onunload` ran and threw a second time on `manifestSync.stop()` because that wasn't constructed either. Two stacked TypeErrors and a dead plugin. Fix: `saveSettings()` now optional-chains the statusBar update (`this.statusBar?.setServerUrl(...)`), and `onunload` wraps each teardown call in a try/catch with optional chaining so a partially-initialized plugin can still unload cleanly. The `onload` already does its own `statusBar.setServerUrl(...)` right after constructing the bar, so the missed update from `loadSettings`-time is picked up immediately.

## 1.0.1 — 2026-05-27

### Security
- **Removed the maintainer's reference-deployment server URL from the codebase.** The default `serverUrl` in `DEFAULT_SETTINGS` was hard-coded to a specific IP that an operator (me) was running, and the same IP appeared in two Setting placeholders, a code comment, and an installation doc. Open repo + UNAUTHENTICATED server mode meant anyone reading the source could connect to that deploy and pollute or read its shared CRDT state. Default `serverUrl` is now `""` — the plugin won't connect until the user fills in their own server URL. Placeholders and doc examples now use `your-server.example.com`. Operators must now run their server with `JWT_SECRET` set (the gate exists since 0.4 but was opt-in); the install doc explicitly tells new users to ask their operator for both the URL and the auth token. The IP is still in the git history of older commits — that's a one-way leak we can't undo without rewriting public history, so the real mitigation is the JWT requirement on the server side, which kicks unauthenticated connections at the handshake.

## 1.0.0 — 2026-05-26

Architectural rewrite of the non-canvas parts of the plugin. Canvas realtime presence (`canvas-cursors.ts`) and the editor↔Y.Text binding (`collab-binding.ts`) are kept byte-identical — both have stabilised through 0.8.x / 0.9.x. Everything else has been redesigned from first principles to kill three classes of bug at the root rather than patching their symptoms one at a time. Existing server state is wiped before deploy; there is no migration path from 0.9.x and the server's `MIN_CLIENT_VERSION` refuses anything below 1.0.0.

### Changed

- **Y.Doc rooms are now keyed by per-file UUID, not by vault path.** Every manifest entry carries a stable `id` (UUID v4) generated at file creation. The Y.Doc room name is `doc:<id>` instead of `file:<path>`. Renames are now a pure metadata operation — `manifestMap.delete(oldPath) + manifestMap.set(newPath, sameEntry)` in a single transaction — and the underlying room (and its CRDT history) follows the entry automatically. Deletes wipe the room and tear down the session under the same UUID; if anyone creates a file at the same path afterwards, a brand-new UUID is minted and a brand-new room opens. The "file rebirth" bug class that 0.5.6, 0.8.3 and 0.9.3 each patched a separate symptom of is now impossible by construction.
- **Binary file bytes moved out of Yjs entirely.** 0.8.x inlined bytes into a shared `Y.Map<Uint8Array>` on the manifest (21 MB manifest on the reference vault). 0.9.x split that into per-file `bin:<path>` Y.Doc rooms (one Y.Doc per binary, refcounted open/close dance, 25 MB cap to avoid Yjs blowing up on large payloads, fragile cross-room byte moves on every rename / soft-delete / restore). 1.0.0 drops CRDTs from the binary path completely. Bytes live in HTTP blob storage on the server, content-addressed by SHA-256 (`/blobs/<hash>` endpoints), and the manifest entry just carries `{ kind: "binary", id, hash, size, mime }`. Uploads PUT the bytes once; if another peer already uploaded the same content the server's HEAD returns 200 and we skip the PUT. Renames don't touch bytes — they're addressed by hash, not by path. Deletes drop the manifest entry; the blob lingers on the server until garbage collection.
- **Single `SessionManager` owns the "is this path bound?" question.** Replaces the path-keyed `sessions` Map, `attachInFlight`, `latestAttachToken`, `boundYtextByEditor`, and the ad-hoc race-prevention scattered through `attachFile` / `onRename` / `onDelete`. Sessions live in a per-path state machine (`detached → attaching → bound → tearing-down`) and every transition is atomic. Concurrent calls for the same path serialise through the per-path state rather than racing on globals. The `latestAttachToken` heuristic is gone — there's nothing to race because the state itself is the source of truth.
- **Plugin source split from one 2 800-line file into focused modules.** `manifest-sync.ts` for the vault structure CRDT, `session-manager.ts` for the session state machine, `text-session.ts` / `canvas-session.ts` / `atomic-text-session.ts` for the three kinds of per-file content sessions, `binary-client.ts` for the HTTP blob client, `trash.ts` for the trash log + modal, `diagnostics.ts` for the status bar and diagnostics command, `util.ts` for hashing / UUIDs / room naming / MIME detection, `types.ts` for the shared vocabulary. `main.ts` is now ~450 lines of orchestration: settings, command palette, vault event wiring, socket lifecycle. `collab-binding.ts` and `canvas-cursors.ts` are unchanged.
- **Canvas session reconstructed in `canvas-session.ts`** without any logic changes from 0.9.x — the JSON ↔ Y.Doc diff-apply, the deep observer, the seed-from-disk-on-first-sync handshake, the canvas-cursors hook attach are all byte-identical. Only the room name changed (UUID-keyed). The user explicitly asked that canvas behaviour not regress; that constraint is enforced by lifting the code in one block rather than rewriting it.
- **Status bar rendering hardened.** Wrapped in a feature check around `addStatusBarItem` so the mobile build (which doesn't expose it) silently no-ops instead of crashing. Progress overlay added: the bar now shows `🟢 collab live (syncing 3/12 binaries)` during initial reconcile, or `(uploading 42%)` during a single-file upload, then returns to the bare connection state when idle.
- **Trash is now a log, not a recovery mechanism.** The 30-day retention + auto-purge stays. The "Restore" button is removed — the modal is informational only, with a note pointing the user at their vault backups. v0.8.3 fixed a sync-killing crash caused by the cross-map trash-byte storage; v0.9.0 moved bytes to per-binary rooms and added cross-room byte moves on restore; both fixes were chasing complexity that originated from the restore feature itself. Removing the feature removes its surface area entirely.

### Added

- **HTTP blob endpoints on the server.** Mounted on Hocuspocus's own HTTP server via the `onRequest` hook, so blobs and WebSocket relay share a single port. `HEAD /blobs/<hash>` returns 200/404, `PUT /blobs/<hash>` streams bytes via `pipeline()` to disk while hashing on the fly (returns 409 on hash mismatch, 201 on success), `GET /blobs/<hash>` streams the file back. Blobs are stored sharded by the first two hex chars of the hash (`<BLOB_DIR>/<aa>/<bbbbcccc…>`) so the dir doesn't degenerate to a single flat directory holding 100 k entries. `OPTIONS` preflight is answered with permissive CORS so the plugin (running inside Obsidian's WebView, which is a unique origin) can call us cross-origin. Auth: when `JWT_SECRET` is set, the HTTP endpoints require the same `Bearer <token>` the WebSocket would — verified under the same secret, so users don't have to configure two separate auth schemes.
- **Protocol version stamped on the manifest.** A new `meta.protocolVersion` field on the manifest Y.Doc, set to `2` by 1.0.0 (0.9.x was implicit v1). On every connect we compare to our compiled-in value. If the server's protocol is newer we enter read-only mode — sessions refuse to attach, vault event handlers no-op — and show a Notice telling the user to update the plugin. Forward-looking infrastructure: no protocol 1 exists in the wild after the wipe, but future protocol bumps now have a safe rejection path instead of silent data corruption.
- **Soft warning for large files instead of a hard cap.** 0.9.x refused to sync any binary above 25 MB. 1.0.0 has no server-side cap (bytes stream in/out, so the server isn't allocating GB of memory per upload) and the plugin shows a brief Notice at 50 MB ("Collab: foo.pdf is 73 MB — sync may take a while") but lets it through. The 50 MB threshold matches the point where Obsidian's vault.readBinary itself starts to become noticeable; below that we don't bother the user.
- **`blobServerUrl` setting** for users who want to point binary uploads at a different host than the WebSocket (different reverse proxy, separate object-storage gateway, etc). Empty by default — derived from `serverUrl` (ws://host:port → http://host:port).

### Removed

- The `bin:<path>` Y.Doc room family. Every code path that opened, refcounted, flushed, or destroyed a per-binary Y.Doc is gone.
- `migrateLegacyBinaries` (0.9.0's one-shot drain of 0.8.x's inline-bytes manifest). The 0.9.x lineage doesn't survive into 1.0.0; the server wipe makes legacy state unreachable.
- Trash restore. See "Trash is now a log" above.
- The 25 MB binary cap. See "Soft warning for large files" above.
- `latestAttachToken` + `attachInFlight` + `boundYtextByEditor`. Replaced by the SessionManager state machine.
- `clearAndPersistEmptyRoom` as a stand-alone routine. The equivalent flow (wipe a room before tearing it down) now lives in `SessionManager.detach` after calling `session.wipe()`, and the `transientWipe` helper in `manifest-sync.ts` covers the never-bound-locally case.
- `pathToRoom`, `pathToBinaryRoom`, `trashUuidToBinaryRoom`. Replaced by a single `docIdToRoom(uuid)` since rooms are no longer path-keyed.

### Breaking

- **`MIN_CLIENT_VERSION` on the server is now `1.0.0`.** 0.9.x clients are refused at WebSocket connect. The reverse is also true — the v1.0 client expects the new manifest schema and the HTTP blob endpoints, neither of which the 0.9.x server provides, so they will not interop. All peers must upgrade together.
- **Existing server state must be wiped before deploy.** The on-wire manifest schema (UUID-keyed entries, hashes for binaries, `meta.protocolVersion`) is incompatible with whatever the SQLite store has from 0.9.x, and the Y.Doc rooms have all been renamed (`doc:<uuid>` instead of `file:<path>` / `bin:<path>`). On the server, delete `data/documents.sqlite` and the `data/blobs/` directory before starting v1.0.0. On each client, run "Collab: Wipe local cache (IndexedDB)" from the command palette (or manually drop every IndexedDB database whose name starts with `obsidian-collab::<serverUrl>::`) before reconnecting. Vault files on disk are NOT touched — the new manifest will be regenerated from local vault contents on first connect.
- **Garbage collection of orphaned blobs is not yet implemented.** The server logs `GC not yet implemented` at startup and will retain every uploaded blob until v1.1 ships the GC walker (referenced-set traversal across all `vault:manifest` Y.Doc states, 24 h grace period for in-flight uploads). For v1.0 deployments the practical impact is that deleting a binary in the vault frees its manifest slot but leaves its bytes on the server's disk. Acceptable for now given the user's vault size; revisit when disk usage becomes a concern.

## 0.9.3 — 2026-05-26

### Fixed
- **"File rebirth" after delete + recreate.** When a user deleted a markdown / canvas / atomic-text file we removed it from the manifest, soft-deleted into trash, and for binaries moved the bytes to a `bin:trash:<uuid>` room — but we never wiped the per-file Y.Doc room itself. Its content stayed on the Hocuspocus server. The next time anyone created a file at the same path our `file:<path>` room reopened, loaded the old persisted state, and the "new" file was born with the deleted content. Confirmed in the wild by a brand-new `Без названия.canvas` immediately materialising at 481 chars right after creation. Fix: on LOCAL delete (only — remote deletes already carry the originator's wipe in flight via the same room), wipe the room's CRDT content before tearing down the session, in the same Y.Doc transaction whose update gets broadcast and persisted. For paths whose session was never opened locally we spin up a transient "wipe-session" — Y.Doc + provider, wait for sync, clear content, hold 1.5 s for the empty state to flush to the server, destroy. Per-session-kind cleanup: `Y.Text.delete(0, length)` for markdown, all-keys-from-each-Map for canvas (`nodes` / `edges` / `meta`), `Map.delete("content")` for atomic-text. Binary bytes already self-clean via the existing `moveBinaryBytes` flow — that path is unchanged.
- **Editor binding could end up wired to a destroyed Y.Text after rapid rename.** Sequence: file gets renamed once → `onRename` destroys the old session, schedules `attachFile(newPath)`. A second rename arrives before the first attach completes → the old `attachFile` either bails on "newer attach superseded us" or finishes binding to a session whose Y.Text is no longer authoritative. The editor's compartment ended up either empty (no binding) or hooked to a dead Y.Text — typing went through Obsidian's auto-save path, bypassed the CRDT, and silently desynced with peers. The diagnostic status bar showed `NOT bound (compartment empty)` after the dust settled. Fix has three parts. (1) `onRename` clears the stale `latestAttachToken` entry for the old path so an in-flight attachFile keyed on that path can no longer mis-supersede the new one. (2) `onRename` for markdown re-attaches whenever a pane is actually displaying the renamed file, even if there was no pre-existing session (covers the case where a previous attach bailed). (3) `attachFile` now records the bound Y.Text per editor view in a `WeakMap<EditorView, Y.Text>` and logs a `stale binding detected` line whenever the editor was previously wired to a different Y.Text than the current session's — we rebind unconditionally each time anyway, but the log makes the next round of "why did my editor lose its binding" debugging immediate.

### Added
- **New command `Wipe local cache (IndexedDB)`.** Manual escape hatch for users whose local IndexedDB has accumulated stale or pre-fix state and who want a clean slate without clicking through DevTools → Application → IndexedDB. Confirms via modal ("This will disconnect, delete all locally cached collab data for `<server URL>`, and reconnect. Vault files on disk are not touched."), then on confirm: disconnects, enumerates `indexedDB.databases()`, deletes every database whose name starts with `obsidian-collab::<serverUrl>::`, shows a Notice with the count, reconnects. Falls back gracefully on Firefox (no `databases()` API): the Notice points the user at DevTools instead. Reconnects automatically either way so they're never left disconnected.
- **High-signal lifecycle logging.** `destroySession` and `createSession` now log the file path and Y.Text length unconditionally (not behind the debug-logging gate). `compartment.reconfigure` logs which file + room + ytext length was installed into each editor. `onRename` logs whether it found a session to tear down and whether it re-attached. `onDelete` logs whether it wiped pre-destroy or skipped wiping because the delete originated remotely. None of this contains note content — just paths, lengths, and which code path was taken — so it's safe to leave on through screen-shares.

### Notes
- `MIN_CLIENT_VERSION` on the server is unchanged. 0.9.3 is forward-compatible with 0.9.x peers: old peers won't wipe Y.Docs on delete (the "file rebirth" can still be triggered by a delete from a 0.9.0–0.9.2 peer until they upgrade), but mixed deployments work correctly otherwise. Upgrade all peers when convenient.

## 0.9.2 — 2026-05-25

### Added
- **Editor↔Y.Text length parity check on every update cycle (defense in depth).** 0.9.1 fixed the specific `RangeError` trigger that produced silent editor/ytext divergence and the resulting doubling loop. This release adds a generic check: at the end of every CodeMirror update cycle, the editor's document length must equal `ytext.length`. If they differ — for any reason, known or unknown — we immediately schedule a full-document replacement that brings the editor back in line with ytext. The cost is one length comparison per update; the upside is that any future bug that would otherwise let the two sides drift apart gets caught on the very first cycle, well before exponential growth can take off. Logged once per divergence episode so a transient resync doesn't spam the console.

## 0.9.1 — 2026-05-25

### Fixed
- **Editor↔Y.Text doubling loop after a failed remote-delta dispatch.** When two peers came online from offline edits and their Y.Text states merged, the receiving editor sometimes got a delta whose positions referenced content the editor hadn't yet caught up to. CodeMirror threw `RangeError: Invalid change range N to N (in doc of length M)`. The thrown dispatch left the editor at the OLD length and Y.Text at the NEW (merged) length — silently divergent. Every subsequent ViewUpdate then re-pushed the editor's stale content into Y.Text as a "fresh user edit", producing the same exponential text-doubling pattern the 0.5.6→0.5.7 fix had cured for a different code path. The fix now catches the RangeError from the observer-side dispatch and force-resyncs the editor by replacing its entire document with `ytext.toString()` in a single COLLAB_SYNC-annotated dispatch. Divergence is impossible to leave behind: either the patched delta lands cleanly, or the editor snaps to the authoritative Y.Text content. The "fresh user edit" loop is starved at the source.

## 0.9.0 — 2026-05-25

### Changed
- **Binary file bytes moved out of the shared vault manifest into per-file Y.Doc rooms.** Until 0.8.x every binary attachment (image, PDF, audio, …) had its raw bytes inlined into a `Y.Map<Uint8Array>` named `binaryData` on the shared `vault:manifest` Y.Doc. On the user's reference vault that grew the manifest to 21 MB even though there were only a handful of actual files, and every new peer had to download the full 21 MB before they could open their first markdown file. Brutal on mobile. As of 0.9.0 each binary lives in its own dedicated room — `bin:<path>` for live files and `bin:trash:<uuid>` for soft-deleted ones — containing a one-key `Y.Map<Uint8Array>` named `blob`. The manifest now only carries the lightweight `path → {kind, createdAt}` existence record, so it stays in the low kilobytes regardless of vault size. Binary rooms are opened lazily (only when uploading, downloading, renaming, or trashing the file) and torn down after the local change has had time to flush to the server. The 30-day trash flow, restore, rename and 25 MB cap all keep working — they now orchestrate cross-room byte moves instead of mutating the manifest.

### Added
- **Automatic one-shot migration of 0.8.x manifests.** On first connect with 0.9.0, if the legacy `binaryData` map still has entries, the plugin drains them into per-file rooms (live paths into `bin:<path>`, `trash:<uuid>` keys into `bin:trash:<uuid>`) and deletes the legacy keys. A `migratedV09` flag is recorded on the manifest's `meta` map so the migration runs at most once per vault. After the next server-side persistence flush the manifest's stored size collapses from tens of MB back to its real footprint.

### Breaking
- **Minimum server-accepted client version bumped to 0.9.0.** 0.8.x clients would happily keep writing into the legacy `binaryData` map after a 0.9.0 peer has migrated away from it, re-bloating the manifest and producing inconsistent state. To prevent that the server now refuses any client below 0.9.0 at connect time. All peers must upgrade together. The user is the only operator, so this is acceptable.

## 0.8.4 — 2026-05-25

### Changed
- **Always-on diagnostic logging for vault event handlers and manifest updates.** `vault.create`, `vault.modify` and the manifest-map change observer now log unconditionally (not gated by the debug-logging setting). The 0.8.3 fix unblocked the bigger issue but a separate report came in that nothing was syncing even with manifest reported as `synced` — and the existing logs gave no signal whether local events were even firing. These new logs make it obvious in 30 seconds whether the bug is upstream (events don't fire), at our handler (suppressed / classified out), or downstream (handler ran but peer never got the manifest change). To be revisited and tightened once the underlying issue is identified.

## 0.8.3 — 2026-05-25

### Fixed
- **Manifest sync silently broken by trash-key collision.** The vault-structure manifest stores raw bytes for every file under its path in `manifestBinaries`. Soft-deleted entries are kept in the same map under reserved keys of the form `trash:<uuid>` so they can be restored later. The remote-update observer was iterating ALL keys of that map, including the `trash:` ones, and feeding them straight to `vault.createBinary()` — which Obsidian rejects because `:` is illegal in vault paths. The thrown exception aborted the rest of the observer's work, so every subsequent remote binary update silently failed too. Worst-case symptom looked like "create some folders, everything stops syncing on both peers", because once a few trash entries accumulated the observer reliably threw on every manifest tick. Fix: skip any key starting with `trash:` in `onBinaryDataChange`. They're handled separately by the restore flow.

## 0.8.2 — 2026-05-25

### Fixed
- **Peer cursors no longer drift during pan/zoom.** The 0.8.1 lerp ran in screen coordinates, so when the local user panned or zoomed the canvas the projection of every peer's world point changed instantly while the cursor — being lerped in screen space — crawled toward the new screen position over the next ~10 frames. Result: cards moved cleanly with the canvas, peer cursors visibly trailed them like they were on a different rubber band. Fixed by lerping in WORLD coordinates and projecting to screen each frame using the current transform. Now the cursor is glued to its world point exactly like the nodes are.
- **Cursor icon now renders on top of selection frames, drag ghosts and marquee rectangles.** Before, those overlays sat at higher DOM index so they painted over the cursor SVG when they happened to coincide. Explicit z-index on each overlay class fixes the stacking: cursor (30) > drag ghost (20) > selection / marquee (10).

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
