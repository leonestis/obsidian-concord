# Changelog

All notable changes are recorded here. The project loosely follows [Semantic Versioning](https://semver.org/) — patch bumps for fixes, minor for features, major for breaking changes.

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
