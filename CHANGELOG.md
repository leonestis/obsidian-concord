# Changelog

All notable changes are recorded here. The project loosely follows [Semantic Versioning](https://semver.org/) — patch bumps for fixes, minor for features, major for breaking changes.

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
