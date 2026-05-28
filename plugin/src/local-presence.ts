// SPDX-License-Identifier: AGPL-3.0-only
//
// Single source of truth for "what does my awareness state look like
// across every bound session right now?". v1.x scattered these writes
// across five places:
//
//   - TextSession.create wrote `user` into each new session's awareness.
//   - SessionManager.bindOne re-wrote `user` and `cursor` after every
//     editor rebind.
//   - SessionManager.publishLocalCursor wrote `cursor` on every
//     idempotent rebind.
//   - SessionManager.awarenessHandoffTo nulled `cursor` on every
//     non-current session and re-wrote `user` on the current one.
//   - TextSession.destroy explicitly cleared the local state before
//     tearing down.
//
// Five callers meant five chances for "I wrote user but not cursor" or
// "I wrote cursor but the previous handoff cleared user before I got
// here" race conditions. v1.0.5's audit B narrowed the user-clobber path
// to a single line but didn't eliminate the structural problem:
// peers occasionally saw "user but no cursor" or "cursor but no name",
// and the bug that flushed it all out — Bug 2 in v1.0.5 — required a
// special-case republish in bindOne to paper over.
//
// v2.0.0 collapses all of that into this one class. Every awareness
// write goes through:
//
//   - setUser(user)          // settings change → user
//   - setCurrentPath(path)   // LiveViewManager focus → path
//
// On any change, the controller walks SessionManager's bound markdown
// sessions and writes a FULL state object per session via
// `awareness.setLocalState({...})`. The current session gets
// `{ user, cursor: lastSeenCursor }` (cursor comes from the active
// editor's selection if we have one, or null otherwise); non-current
// sessions get `{ user, cursor: null }`.
//
// Note on broadcast semantics: y-protocols' awareness fires its
// 'change' / 'update' observer whenever setLocalState is called AND the
// new state is not deep-equal to the prior one (it does NOT fire on a
// byte-for-byte identical re-write — an earlier comment here claimed it
// "ALWAYS fires"; that was wrong). We don't rely on identical-state
// rebroadcasts. On a return-to-file the active session's state
// genuinely differs from its prior `{user, cursor:null}` (cursor is
// re-established by the editor's next publish, and the path-change path
// here resets lastCursor), so a real change is emitted and peers redraw.
// The durable invariant that fixes the "friend invisible" class of bugs
// is simpler: this controller is the SOLE writer of local awareness
// state. No other module nulls or removes it mid-life anymore.

import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { log } from "./logger";
import type { SessionManager } from "./session-manager";
import type { TextSession } from "./text-session";

export interface LocalUser {
  name: string;
  color: string;
}

export interface SerialisedCursor {
  // JSON form of Y.RelativePosition. Stored as `unknown` here because
  // RelativePosition's runtime shape is internal to Yjs; what matters
  // is the y-protocols/awareness serializer can round-trip it.
  anchor: unknown;
  head: unknown;
}

export interface AwarenessState {
  user: LocalUser;
  cursor: SerialisedCursor | null;
}

export class LocalPresenceController {
  private user: LocalUser;
  private currentPath: string | null = null;
  // Cached last-known cursor for the active session, used so we can
  // re-publish a sensible state when setUser/refresh fires before the
  // editor plugin has had a chance to publish.
  private lastCursor: SerialisedCursor | null = null;

  constructor(
    private readonly sessionManager: SessionManager,
    initialUser: LocalUser,
  ) {
    this.user = initialUser;
  }

  // Called by main.ts on settings load + on every settings change.
  // Re-broadcasts to every bound session so peers see the rename
  // (or color change) immediately.
  setUser(user: LocalUser): void {
    if (this.user.name === user.name && this.user.color === user.color) return;
    this.user = user;
    log.info("binding", `LocalPresence.setUser: ${user.name} (${user.color})`);
    this.broadcastAll();
  }

  getUser(): LocalUser {
    return this.user;
  }

  // Called by LiveViewManager every time the workspace's focus shifts
  // to a different markdown file (or away from any markdown file).
  //
  // Walks every bound markdown session:
  //   - session.path === newPath → writes `{ user, cursor: lastCursor }`
  //     (so peers see us appear immediately, even before the editor's
  //     ViewPlugin gets around to publishing a real cursor).
  //   - otherwise → writes `{ user, cursor: null }` (so peers see us
  //     leave that file; no stale cursor frozen in place).
  //
  // Calling with the same path twice is idempotent for our internal
  // bookkeeping but STILL broadcasts to every session — setLocalState
  // fires the awareness observer on every full-object write, which is
  // exactly what we want when a peer just joined and needs to see our
  // state appear in their getStates() map.
  setCurrentPath(newPath: string | null): void {
    const pathChanged = this.currentPath !== newPath;
    if (pathChanged) {
      log.info(
        "binding",
        `LocalPresence.setCurrentPath: ${this.currentPath ?? "(none)"} → ${newPath ?? "(none)"}`,
      );
    }
    this.currentPath = newPath;
    // When path changes, drop the stale cursor — it referenced the
    // previous file's Y.Text. The remote-selections plugin will publish
    // a fresh one for the new file on its next update().
    if (pathChanged) this.lastCursor = null;
    this.broadcastAll();
  }

  getCurrentPath(): string | null {
    return this.currentPath;
  }

  // Internal: write the appropriate state into every bound markdown
  // session's awareness. Called from setUser and setCurrentPath, and
  // exposed as `refresh` for one external caller (LiveViewManager,
  // after attaching a brand new session whose awareness we haven't
  // touched yet).
  refresh(): void {
    this.broadcastAll();
  }

  private broadcastAll(): void {
    for (const { path, session } of this.sessionManager.boundMarkdownSessions()) {
      const awareness = session.provider.awareness;
      if (!awareness) continue;
      const isCurrent = path === this.currentPath;
      const state: AwarenessState = {
        user: this.user,
        cursor: isCurrent ? this.lastCursor : null,
      };
      try {
        // setLocalState (not setLocalStateField) — writes the full
        // { user, cursor } object so identity and cursor are always set
        // together as one atomic state. y-protocols fires the awareness
        // observer when this differs from the prior state (it does not
        // fire on an identical re-write — see the file header). On the
        // paths that call broadcastAll (user change, path change) the
        // state genuinely differs, so the redraw we want is emitted.
        awareness.setLocalState(state as unknown as Record<string, unknown>);
      } catch (err) {
        log.warn(
          "binding",
          `LocalPresence.broadcast failed for ${path}`,
          err,
        );
      }
    }
  }

  // Internal helper for tests / future hooks: capture the current
  // editor's cursor into our cache so the next broadcastAll() picks
  // it up. v2.0.0 doesn't use this from any caller — the editor
  // ViewPlugin writes cursor directly on selection changes — but it's
  // here so a future Phase 3 hook can wire it in without changing the
  // class shape.
  recordCursor(cursor: SerialisedCursor | null): void {
    this.lastCursor = cursor;
  }

  // For diagnostics: produce a stable string summarising current state.
  // Used by the show-status command via SessionManager.describe().
  describe(): string {
    return `user=${this.user.name}/${this.user.color} currentPath=${this.currentPath ?? "(none)"}`;
  }

  // Convenience: build a cursor JSON for a Y.Text + index, for callers
  // that want to seed an initial cursor explicitly (none in v2.0.0,
  // but kept for symmetry with v1.x's publishLocalCursor helper).
  static makeCursor(ytext: Y.Text, anchor: number, head: number): SerialisedCursor {
    return {
      anchor: Y.createRelativePositionFromTypeIndex(ytext, anchor),
      head: Y.createRelativePositionFromTypeIndex(ytext, head),
    };
  }
}

export type BoundMarkdownSession = {
  path: string;
  session: TextSession;
};
