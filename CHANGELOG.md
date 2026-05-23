# Changelog

All notable changes are recorded here. The project loosely follows [Semantic Versioning](https://semver.org/) — patch bumps for fixes, minor for features, major for breaking changes.

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
