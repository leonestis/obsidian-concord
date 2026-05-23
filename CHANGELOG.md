# Changelog

All notable changes are recorded here. The project loosely follows [Semantic Versioning](https://semver.org/) — patch bumps for fixes, minor for features, major for breaking changes.

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
