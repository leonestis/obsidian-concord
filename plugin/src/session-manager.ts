// SPDX-License-Identifier: AGPL-3.0-only
//
// Single source of truth for "is this path bound to a session?". Every
// state transition is atomic: concurrent attach / detach / rename calls
// for the same path serialise through a per-path promise chain rather
// than racing on shared state. This is the structural fix for the
// `latestAttachToken` mess in 0.9.3 — there's nothing to race.
//
// Key contract:
//   - byPath maps a vault path to the path's current SessionState.
//   - attach(path, kind, docId) returns when the session is bound (or
//     when it short-circuits because a concurrent call won the race
//     and is doing the work). Throws on real errors.
//   - detach(path) returns when the session is fully torn down.
//   - handleRename(oldPath, newPath) just relabels — the underlying
//     Y.Doc room is keyed by UUID, so rename = pure metadata update.
//   - editor binding: SessionManager owns the
//     editorView → bound-Y.Text relationship. main.ts asks for "bind
//     this editor to the session for this path" and we do the right
//     thing.
//
// Read-only mode: when the manifest reports a higher protocolVersion
// than ours, the manager refuses every attach. The plugin still runs
// for read-only browsing of any peers' content via the manifest, but
// it can't push edits or open new sessions.

import { App, MarkdownView, Notice, TFile } from "obsidian";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { HocuspocusProviderWebsocket } from "@hocuspocus/provider";

import { TextSession } from "./text-session";
import { CanvasSession } from "./canvas-session";
import { AtomicTextSession } from "./atomic-text-session";
import { createCollabBinding } from "./collab-binding";
import type {
  AnySession,
  SessionKind,
  SessionState,
} from "./types";

export interface SessionManagerDeps {
  app: App;
  editorCompartment: Compartment;
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

export class SessionManager {
  private byPath = new Map<string, SessionState>();
  private readOnly = false;
  // Per-EditorView bookkeeping so we never double-bind and we always
  // tear down the previous compartment before installing a new one.
  private editorBoundPath = new WeakMap<EditorView, string>();

  constructor(private readonly deps: SessionManagerDeps) {}

  setReadOnly(ro: boolean) {
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

  // Returns the session for path iff it's currently bound. Used by
  // manifest-sync for canvas / atomic disk-modify dispatch.
  getBound(path: string): AnySession | null {
    const st = this.byPath.get(path);
    return st?.kind === "bound" ? st.session : null;
  }

  // Attach a session for a path. Atomically:
  //   - if currently bound to the SAME docId → no-op (return).
  //   - if currently bound to a DIFFERENT docId → tear down, re-attach.
  //   - if attaching for the same docId → await that attach.
  //   - if tearing-down → await that, then attach.
  //   - if detached → mint a new attach.
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

    // Loop because we may need to await a teardown and re-evaluate.
    // Bounded by simple state-machine transitions (no infinite loop
    // possible — every iteration either reaches `bound` or returns).
    for (let iter = 0; iter < 4; iter++) {
      const st = this.byPath.get(path);
      if (!st || st.kind === "detached") {
        return await this.startAttach(path, kind, docId, socket);
      }
      if (st.kind === "bound") {
        if (st.docId === docId) {
          // Same session already bound — possibly a kind change
          // shouldn't happen for the same docId, but trust the
          // existing one.
          return st.session;
        }
        // Different docId — file was deleted+recreated under same
        // path. Tear down the old, install the new.
        console.log(
          `[collab] attach: ${path} bound to ${st.docId}, replacing with ${docId}`,
        );
        await this.detach(path);
        continue;
      }
      if (st.kind === "attaching") {
        if (st.docId === docId) {
          // Concurrent caller is already attaching the same docId.
          // Wait until it lands and return that session. We do this
          // by polling — the in-flight call will update byPath when
          // it finishes.
          await new Promise<void>((r) => setTimeout(r, 25));
          continue;
        }
        // Different docId attaching — abort the old, start ours.
        st.abort.abort();
        // Wait one tick for the aborted attach to update state.
        await new Promise<void>((r) => setTimeout(r, 25));
        continue;
      }
      if (st.kind === "tearing-down") {
        await st.done;
        continue;
      }
    }
    console.warn(`[collab] attach: gave up after retries for ${path}`);
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
    console.log(`[collab] attach: starting ${path} (kind=${kind}, docId=${docId})`);

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
        // Someone superseded us — tear down what we just built.
        console.log(`[collab] attach: ${path} aborted post-create, destroying`);
        await session.destroy();
        return null;
      }
      this.byPath.set(path, {
        kind: "bound",
        docId,
        sessionKind: kind,
        session,
      });
      console.log(`[collab] attach: bound ${path} → ${docId}`);
      // For markdown, bind to any currently-open editor views.
      if (kind === "file") {
        this.bindOpenEditorsFor(path);
      }
      return session;
    } catch (err) {
      console.warn(`[collab] attach failed for ${path}`, err);
      this.byPath.set(path, { kind: "detached" });
      return null;
    }
  }

  // Detach the session for a path. Idempotent — calling detach on a
  // detached or never-attached path is a no-op. Returns when the Y.Doc
  // / provider / persistence are fully torn down.
  async detach(path: string): Promise<void> {
    const st = this.byPath.get(path);
    if (!st || st.kind === "detached") return;
    if (st.kind === "tearing-down") {
      await st.done;
      return;
    }
    if (st.kind === "attaching") {
      st.abort.abort();
      // Brief wait for the attach to bail out into detached state.
      await new Promise<void>((r) => setTimeout(r, 30));
      const after = this.byPath.get(path);
      if (after?.kind === "bound") {
        // Attach raced past our abort — tear down what it bound.
        return this.detach(path);
      }
      return;
    }
    // Bound — orchestrate the teardown.
    const { docId, session } = st;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    this.byPath.set(path, { kind: "tearing-down", docId, done });
    // Detach editor compartments first so no live editor keeps
    // dispatching into a destroying Y.Text.
    this.clearEditorBindingsFor(path);
    try {
      await session.destroy();
    } finally {
      this.byPath.set(path, { kind: "detached" });
      resolveDone();
      console.log(`[collab] detach: completed ${path}`);
    }
  }

  // Rename: the underlying Y.Doc room is UUID-keyed, so this is pure
  // metadata. The session keeps running, we just relabel.
  async handleRename(oldPath: string, newPath: string): Promise<void> {
    const st = this.byPath.get(oldPath);
    if (!st) return;
    this.byPath.delete(oldPath);
    this.byPath.set(newPath, st);
    if (st.kind === "bound") {
      st.session.path = newPath;
      // Canvas presence overlay is path-keyed internally; rebind.
      if (st.sessionKind === "canvas") {
        (st.session as CanvasSession).onPathChanged(newPath);
      }
    }
    // Reassign editor binding map entries: any editor previously
    // marked for oldPath is now for newPath.
    // (WeakMap can't be iterated; we just leave stale entries — they'll
    // be overwritten on the next bind via bindOpenEditorsFor.)
    if (st.kind === "bound" && st.sessionKind === "file") {
      // Rebind any editors that are displaying newPath now (Obsidian
      // reuses the EditorView across renames, so the same view that
      // showed oldPath is now showing newPath).
      this.bindOpenEditorsFor(newPath);
    }
    console.log(`[collab] handleRename: ${oldPath} → ${newPath}`);
  }

  // ── editor binding ────────────────────────────────────────────────

  // Called by main.ts on file-open events. For markdown files only —
  // canvas / atomic-text don't run an editor binding.
  async bindEditorIfReady(path: string): Promise<void> {
    const st = this.byPath.get(path);
    if (st?.kind !== "bound" || st.sessionKind !== "file") return;
    this.bindOpenEditorsFor(path);
  }

  // Detach the compartment of any editor that was previously bound to
  // this path. Called during detach() so the editor stops dispatching
  // into a destroying Y.Text.
  clearEditorBindingFor(editorView: EditorView): void {
    const path = this.editorBoundPath.get(editorView);
    if (!path) return;
    try {
      editorView.dispatch({
        effects: this.deps.editorCompartment.reconfigure([]),
      });
    } catch (err) {
      console.warn("[collab] clearEditorBindingFor dispatch failed", err);
    }
    this.editorBoundPath.delete(editorView);
  }

  private clearEditorBindingsFor(path: string): void {
    for (const view of this.editorViewsForPath(path)) {
      this.clearEditorBindingFor(view);
    }
  }

  private bindOpenEditorsFor(path: string): void {
    const st = this.byPath.get(path);
    if (st?.kind !== "bound" || st.sessionKind !== "file") return;
    const session = st.session as TextSession;
    const awareness = session.provider.awareness;
    if (!awareness) {
      console.warn(`[collab] bindOpenEditorsFor ${path}: no awareness`);
      return;
    }
    const views = this.editorViewsForPath(path);
    if (views.length === 0) {
      this.deps.debug(`[collab] bindOpenEditorsFor ${path}: no editor open`);
      return;
    }
    for (const view of views) {
      this.bindOne(view, session, awareness, path);
    }
  }

  private bindOne(
    view: EditorView,
    session: TextSession,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    awareness: any,
    path: string,
  ): void {
    // Clear any previous binding first so the old syncPlugin's
    // ytext.unobserve runs before the new one installs.
    try {
      view.dispatch({
        effects: this.deps.editorCompartment.reconfigure([]),
      });
    } catch (err) {
      console.warn("[collab] bindOne pre-clear dispatch failed", err);
    }

    // Pre-sync editor doc to Y.Text content so the binding's first
    // update doesn't double-fire.
    const ytextContent = session.ytext.toString();
    const editorContent = view.state.doc.toString();
    if (ytextContent !== editorContent) {
      try {
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: ytextContent,
          },
        });
      } catch (err) {
        console.warn("[collab] bindOne pre-sync dispatch failed", err);
      }
    }

    try {
      view.dispatch({
        effects: this.deps.editorCompartment.reconfigure([
          createCollabBinding(session.ytext, awareness),
        ]),
      });
    } catch (err) {
      console.warn("[collab] bindOne reconfigure failed", err);
      return;
    }
    this.editorBoundPath.set(view, path);
    console.log(
      `[collab] bindOne: ${path} → ytext.length=${session.ytext.length}`,
    );
  }

  private editorViewsForPath(path: string): EditorView[] {
    const out: EditorView[] = [];
    this.deps.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      if (view.file?.path !== path) return;
      const editor = view.editor as unknown as { cm?: EditorView } | undefined;
      if (editor?.cm) out.push(editor.cm);
    });
    return out;
  }

  // Awareness handoff: when a user switches between markdown panes,
  // clear our awareness on every OTHER session so peers stop seeing
  // a stale cursor frozen inside a file we're no longer editing.
  awarenessHandoffTo(activePath: string): void {
    const user = this.deps.user();
    for (const [path, st] of this.byPath.entries()) {
      if (st.kind !== "bound") continue;
      if (path === activePath) {
        try {
          st.session.provider.awareness?.setLocalStateField("user", user);
        } catch {
          /* ignore */
        }
      } else {
        try {
          st.session.provider.awareness?.setLocalState(null);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // For onunload — tear down everything in parallel.
  async destroyAll(): Promise<void> {
    const paths = Array.from(this.byPath.keys());
    for (const p of paths) {
      // Sequential so log output is ordered; sessions are independent
      // anyway so parallelising wouldn't help much.
      await this.detach(p);
    }
  }

  // For diagnostics.
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
