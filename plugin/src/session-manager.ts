// SPDX-License-Identifier: AGPL-3.0-only
//
// SessionManager v2.0.0 — session lifecycle ONLY.
//
// v1.x's SessionManager also owned the editor binding (bindOne /
// bindOpenEditorsFor / publishLocalCursor / awarenessHandoffTo /
// editorBoundPath / clearEditorBindingFor) and the editor compartment.
// v2.0.0 moves all of that to LiveViewManager + LocalPresenceController.
// This class is now a thin facade over the per-path state machine
// (detached / attaching / bound / tearing-down) plus a few iterator
// helpers consumed by the new controllers.
//
// What stayed:
//   - byPath Map<string, SessionState> — single source of truth for
//     "is this path bound?".
//   - attach(path, kind, docId) — creates / returns the session, async
//     factory chain, abort-on-supersede.
//   - detach(path) — tears down the provider / Y.Doc / persistence.
//   - handleRename(oldPath, newPath) — pure relabel, same UUID, same
//     room.
//   - destroyAll() — for onunload.
//   - describe() — for diagnostics.
//
// What's new in v2.0.0:
//   - boundMarkdownSessions() — iterator for LocalPresenceController.
//   - On every "bound" transition, fire ManifestSync's sessionReady
//     event (configured via setSessionReadyEmitter). v2.0.0 only fires
//     this for markdown sessions because LiveViewManager only cares
//     about markdown leaves; canvas / atomic-text sessions are still
//     driven by manifest-sync's reconcile.
//
// What got deleted:
//   - editorBoundPath WeakMap, editorCompartment, bindEditorIfReady,
//     bindOpenEditorsFor, bindOne, clearEditorBindingFor,
//     clearEditorBindingsFor, publishLocalCursor, awarenessHandoffTo,
//     editorViewsForPath.

import { App, Notice } from "obsidian";
import type { HocuspocusProviderWebsocket } from "@hocuspocus/provider";

import { log } from "./logger";
import { TextSession } from "./text-session";
import { CanvasSession } from "./canvas-session";
import { AtomicTextSession } from "./atomic-text-session";
import type {
  AnySession,
  SessionKind,
  SessionState,
} from "./types";
import type { BoundMarkdownSession } from "./local-presence";

export interface SessionManagerDeps {
  app: App;
  getSocket: () => HocuspocusProviderWebsocket | null;
  serverUrl: () => string;
  authToken: () => string | undefined;
  user: () => { name: string; color: string };
  remoteApplyPaths: {
    add: (p: string) => void;
    delete: (p: string) => void;
    has: (p: string) => boolean;
  };
  debug: (...args: unknown[]) => void;
}

// Callback registered by ManifestSync at construction time. Fired
// whenever a session reaches the `bound` state. LiveViewManager
// subscribes (via ManifestSync's onSessionReady wrapper) and uses it
// to know when to attempt binding a file whose leaf is already open.
type SessionReadyEmitter = (path: string, kind: SessionKind) => void;

export class SessionManager {
  private byPath = new Map<string, SessionState>();
  private readOnly = false;
  private emitSessionReady: SessionReadyEmitter | null = null;

  constructor(private readonly deps: SessionManagerDeps) {}

  // Wired by main.ts after ManifestSync construction. Not in the
  // constructor because the events emitter lives on ManifestSync, and
  // SessionManager is constructed before ManifestSync.
  setSessionReadyEmitter(emit: SessionReadyEmitter | null): void {
    this.emitSessionReady = emit;
  }

  setReadOnly(ro: boolean): void {
    if (ro && !this.readOnly) {
      new Notice(
        "Collab: server is on a newer protocol. Plugin running read-only — please update.",
        15_000,
      );
    }
    this.readOnly = ro;
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  isActive(path: string): boolean {
    return this.byPath.get(path)?.kind === "bound";
  }

  // Returns the session for `path` iff currently bound. Used by
  // manifest-sync for canvas/atomic dispatch and by LiveViewManager's
  // resolveContext for markdown.
  getBound(path: string): AnySession | null {
    const st = this.byPath.get(path);
    return st?.kind === "bound" ? st.session : null;
  }

  // Iterator of currently-bound markdown sessions. Used by
  // LocalPresenceController to broadcast awareness state across all
  // sessions on every focus / user change.
  *boundMarkdownSessions(): IterableIterator<BoundMarkdownSession> {
    for (const [path, st] of this.byPath) {
      if (st.kind !== "bound") continue;
      if (st.sessionKind !== "file") continue;
      yield { path, session: st.session as TextSession };
    }
  }

  // Attach a session for a path. State-machine semantics carried over
  // from v1.x — see the long comment in that file for the full
  // analysis of why concurrent attach/detach must serialise through a
  // single state map.
  async attach(
    path: string,
    kind: SessionKind,
    docId: string,
  ): Promise<AnySession | null> {
    if (this.readOnly) {
      this.deps.debug(`[collab] attach refused (read-only): ${path}`);
      return null;
    }
    const socket = this.deps.getSocket();
    if (!socket) {
      this.deps.debug(`[collab] attach: no socket, skipping ${path}`);
      return null;
    }

    for (let iter = 0; iter < 4; iter++) {
      const st = this.byPath.get(path);
      if (!st || st.kind === "detached") {
        return await this.startAttach(path, kind, docId, socket);
      }
      if (st.kind === "bound") {
        if (st.docId === docId) return st.session;
        // Same path, different docId — file was deleted + recreated.
        log.info(
          "session",
          `attach: ${path} bound to ${st.docId}, replacing with ${docId}`,
        );
        await this.detach(path);
        continue;
      }
      if (st.kind === "attaching") {
        if (st.docId === docId) {
          await new Promise<void>((r) => setTimeout(r, 25));
          continue;
        }
        st.abort.abort();
        await new Promise<void>((r) => setTimeout(r, 25));
        continue;
      }
      if (st.kind === "tearing-down") {
        await st.done;
        continue;
      }
    }
    log.warn("session", `attach: gave up after retries for ${path}`);
    return null;
  }

  private async startAttach(
    path: string,
    kind: SessionKind,
    docId: string,
    socket: HocuspocusProviderWebsocket,
  ): Promise<AnySession | null> {
    const abort = new AbortController();
    this.byPath.set(path, { kind: "attaching", docId, sessionKind: kind, abort });
    log.info("session", `attach: starting ${path} (kind=${kind}, docId=${docId})`);

    try {
      const baseOpts = {
        app: this.deps.app,
        socket,
        serverUrl: this.deps.serverUrl(),
        authToken: this.deps.authToken(),
        docId,
        path,
        user: this.deps.user(),
        remoteApplyPaths: this.deps.remoteApplyPaths,
        debug: this.deps.debug,
      };
      let session: AnySession;
      if (kind === "file") {
        session = await TextSession.create(baseOpts);
      } else if (kind === "canvas") {
        session = new CanvasSession(baseOpts);
      } else {
        session = new AtomicTextSession(baseOpts);
      }
      if (abort.signal.aborted) {
        log.info("session", `attach: ${path} aborted post-create, destroying`);
        await session.destroy();
        return null;
      }
      this.byPath.set(path, {
        kind: "bound",
        docId,
        sessionKind: kind,
        session,
      });
      log.info("session", `attach: bound ${path} → ${docId}`);

      // Fire sessionReady — LiveViewManager listens (via ManifestSync's
      // re-export) and queues a refresh that picks up this file if its
      // leaf is already open.
      if (this.emitSessionReady) {
        try {
          this.emitSessionReady(path, kind);
        } catch (err) {
          log.warn(
            "session",
            `emitSessionReady threw for ${path}`,
            err,
          );
        }
      }
      return session;
    } catch (err) {
      log.warn("session", `attach failed for ${path}`, err);
      this.byPath.set(path, { kind: "detached" });
      return null;
    }
  }

  async detach(path: string): Promise<void> {
    const st = this.byPath.get(path);
    if (!st || st.kind === "detached") return;
    if (st.kind === "tearing-down") {
      await st.done;
      return;
    }
    if (st.kind === "attaching") {
      st.abort.abort();
      await new Promise<void>((r) => setTimeout(r, 30));
      const after = this.byPath.get(path);
      if (after?.kind === "bound") return this.detach(path);
      return;
    }
    const { docId, session } = st;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    this.byPath.set(path, { kind: "tearing-down", docId, done });
    try {
      await session.destroy();
    } finally {
      this.byPath.set(path, { kind: "detached" });
      resolveDone();
      log.info("session", `detach: completed ${path}`);
    }
  }

  // Rename = pure relabel. The Y.Doc room is UUID-keyed, content
  // persists, the editor binding (now owned by LiveViewManager) gets
  // re-routed automatically on the next refresh because LiveView's
  // .path is updated by LiveViewManager.runRefresh when the leaf's
  // file changes path.
  async handleRename(oldPath: string, newPath: string): Promise<void> {
    const st = this.byPath.get(oldPath);
    if (!st) return;
    this.byPath.delete(oldPath);
    this.byPath.set(newPath, st);
    if (st.kind === "bound") {
      st.session.path = newPath;
      if (st.sessionKind === "canvas") {
        (st.session as CanvasSession).onPathChanged(newPath);
      }
    }
    log.info("session", `handleRename: ${oldPath} → ${newPath}`);
  }

  async destroyAll(): Promise<void> {
    const paths = Array.from(this.byPath.keys());
    for (const p of paths) {
      await this.detach(p);
    }
  }

  describe(): Array<{ path: string; state: string; docId?: string }> {
    const out: Array<{ path: string; state: string; docId?: string }> = [];
    for (const [path, st] of this.byPath.entries()) {
      if (st.kind === "detached") out.push({ path, state: "detached" });
      else if (st.kind === "attaching")
        out.push({ path, state: "attaching", docId: st.docId });
      else if (st.kind === "tearing-down")
        out.push({ path, state: "tearing-down", docId: st.docId });
      else
        out.push({
          path,
          state: `bound:${st.sessionKind}`,
          docId: st.docId,
        });
    }
    return out;
  }
}
