// SPDX-License-Identifier: AGPL-3.0-only
//
// LiveViewManager — derived from Relay's LiveViews.ts (MIT) and adapted
// for obsidian-collab's UUID-keyed manifest + SessionManager.
//
// Architecture (v2.0.0):
//
// Global editor extension. The yedit plugins are installed ONCE via
// `Plugin.registerEditorExtension`, applied to every CodeMirror editor
// Obsidian opens. The extension carries a single global resolveContext
// function that takes the EditorView and routes to the right session
// for whichever file that view is currently displaying — looked up
// from Obsidian's `editorInfoField`. The plugins themselves are stable
// across file switches because the SAME plugin instance handles every
// editor in the workspace; only its internal "what session am I bound
// to" state changes when the user navigates.
//
// LiveViewManager doesn't reconfigure compartments. It exists to:
//
//   1. Track the set of leaves Obsidian thinks should be "live" (have
//      a bound session whose markdown content is being edited).
//      Updated on every workspace event.
//
//   2. Drive SessionManager.attach for files whose leaf is currently
//      open but whose session hasn't been created yet. The lazy-create
//      path that pre-v2.0 used main.ts's handleMarkdownFileOpen for.
//
//   3. Notify LocalPresenceController on focus changes so it can do
//      the awareness cursor handoff across files.
//
//   4. Expose resolveContext() — called from the global yedit plugins.
//      Reads editorInfoField.file from the EditorView's state, looks
//      up the manifest entry + bound session, returns YeditContext.
//
// The "active" flag on a context. We don't actually mark leaves
// inactive in this design — every leaf with a manifest entry is
// considered live. The "inert" path in yedit happens automatically:
//   - If the editor is showing a file with no manifest entry, the
//     resolver returns null → plugin no-ops.
//   - If the leaf is destroyed, the editor itself is destroyed; the
//     yedit destroy() runs; the Y.Text subscription goes away.
//   - On file switch WITHIN a leaf, Obsidian REUSES the same
//     EditorView (it does NOT destroy + recreate it). The same yedit
//     ViewPlugin instances survive the switch; only the file backing
//     the view's editorInfoField changes. That's exactly why yedit
//     resolves its context dynamically (resolveContext, below) on every
//     update() instead of capturing ytext/awareness in its constructor:
//     there's no construction event on a switch to re-capture at. (An
//     earlier comment here wrongly claimed Obsidian destroys the editor
//     on switch; it does not, and that false assumption is what made
//     the old removeAwarenessStates-on-switch logic in y-sync wipe the
//     local awareness mid-life — the "friend invisible" bug.)
//
// This is simpler than Relay's CSS-class allowlist because Obsidian's
// editor lifecycle already gives us a clean teardown.
//
// We do NOT cap connections in v2.0.0 — Phase 7 will add the
// BACKGROUND_CONNECTIONS pool. All bound markdown sessions stay
// connected so peers' edits always flow in.

import { App, MarkdownView, TFile, editorInfoField } from "obsidian";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { log } from "./logger";
import type { ManifestSync } from "./manifest-sync";
import type { SessionManager } from "./session-manager";
import type { LocalPresenceController } from "./local-presence";
import type { TextSession } from "./text-session";
import { yCollab, yeditWake, type YeditContext } from "./yedit/y-collab";

export interface LiveViewManagerDeps {
  app: App;
  sessionManager: SessionManager;
  manifestSync: ManifestSync;
  presence: LocalPresenceController;
}

export class LiveViewManager {
  private readonly app: App;
  private readonly sessionManager: SessionManager;
  private readonly manifestSync: ManifestSync;
  private readonly presence: LocalPresenceController;

  // Tracking set of leaf-ids we've SEEN as carrying a markdown file
  // with a manifest entry. Used purely for diagnostics + to know which
  // paths to attempt SessionManager.attach for. The yedit plugins
  // discover their own ytext/awareness via resolveContext.
  private knownPaths = new Set<string>();

  // Single-flight refresh queue. If a refresh is in flight when another
  // is requested, the in-flight one finishes first and a fresh one is
  // scheduled.
  private refreshPending: Promise<void> | null = null;
  private refreshQueued = false;

  // Event unsubscribers; we call them all on destroy().
  private unsubs: Array<() => void> = [];
  // ManifestSync's sessionReady listener.
  private sessionReadyOff: (() => void) | null = null;

  private destroyed = false;

  constructor(deps: LiveViewManagerDeps) {
    this.app = deps.app;
    this.sessionManager = deps.sessionManager;
    this.manifestSync = deps.manifestSync;
    this.presence = deps.presence;

    // workspace event subscriptions. Obsidian's EventRef-based API
    // returns a ref we pass back to offref. Wrap each in an unsub
    // closure stored in this.unsubs for clean teardown.
    const ws = this.app.workspace;
    const reg = (ref: ReturnType<typeof ws.on>) => {
      this.unsubs.push(() => ws.offref(ref));
    };
    reg(
      ws.on("layout-change", () => {
        this.queueRefresh("layout-change");
      }),
    );
    reg(
      ws.on("file-open", () => {
        this.queueRefresh("file-open");
      }),
    );
    reg(
      ws.on("active-leaf-change", () => {
        this.queueRefresh("active-leaf-change");
      }),
    );

    const vault = this.app.vault;
    const regV = (ref: ReturnType<typeof vault.on>) => {
      this.unsubs.push(() => vault.offref(ref));
    };
    regV(
      vault.on("rename", () => {
        this.queueRefresh("vault.rename");
      }),
    );
    regV(
      vault.on("delete", () => {
        this.queueRefresh("vault.delete");
      }),
    );

    // ManifestSync event emitter — fires when a session reaches `bound`.
    if (typeof (this.manifestSync as unknown as { onSessionReady?: unknown }).onSessionReady === "function") {
      this.sessionReadyOff = (this.manifestSync as unknown as {
        onSessionReady: (cb: (path: string) => void) => () => void;
      }).onSessionReady((path: string) => {
        log.info(
          "binding",
          `LiveViewManager: sessionReady ${path} → queueing refresh`,
        );
        this.queueRefresh(`sessionReady(${path})`);
      });
    }
  }

  // The global editor extension. Mounted once via
  // Plugin.registerEditorExtension; every CodeMirror editor Obsidian
  // creates gets this installed. The Facet carries our resolveContext
  // function, which reads `editorInfoField.file` from the view's state
  // to discover which file (and thus which session) the view should
  // bind to.
  editorExtension(): Extension {
    return yCollab((view) => this.resolveContext(view));
  }

  // ── refresh ────────────────────────────────────────────────────────

  queueRefresh(reason: string): void {
    if (this.destroyed) return;
    if (this.refreshPending) {
      this.refreshQueued = true;
      return;
    }
    this.refreshPending = (async () => {
      await Promise.resolve();
      try {
        await this.runRefresh(reason);
        while (this.refreshQueued && !this.destroyed) {
          this.refreshQueued = false;
          await this.runRefresh(`coalesced after ${reason}`);
        }
      } finally {
        this.refreshPending = null;
      }
    })();
  }

  async refreshNow(): Promise<void> {
    this.queueRefresh("refreshNow");
    if (this.refreshPending) await this.refreshPending;
  }

  // The actual refresh. Walks workspace leaves, for each markdown leaf
  // whose file is in the manifest as a "file" entry but has no bound
  // session yet → kick SessionManager.attach. After attach completes,
  // SessionManager fires sessionReady → ManifestSync re-fires →
  // we queue another refresh, then kick a wake-transaction into every
  // open editor showing the now-bound file so y-sync's update() fires
  // and rebinds to the new context.
  //
  // For "active path" handoff: we read workspace.getActiveFile() and
  // tell LocalPresenceController, which writes the appropriate state
  // into each bound session's awareness. This is the source of truth
  // for "which file is the user editing right now?".
  private async runRefresh(reason: string): Promise<void> {
    if (this.destroyed) return;
    const seenPaths = new Set<string>();
    // Track editors we wake on this pass so we don't double-wake one
    // editor when it shows up via more than one leaf (split panes).
    const wokenEditors = new Set<EditorView>();

    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      const file = view.file;
      if (!(file instanceof TFile)) return;
      if (file.extension !== "md") return;
      const path = file.path;
      seenPaths.add(path);
      const entry = this.manifestSync.getEntry(path);
      if (!entry || entry.kind !== "file") return;
      // Kick attach for unbound files; SessionManager.attach is
      // state-machine-protected so multiple concurrent calls collapse
      // to one.
      if (!this.sessionManager.getBound(path)) {
        log.info(
          "binding",
          `LiveViewManager: ensuring session for ${path} (docId=${entry.id})`,
        );
        void this.sessionManager.attach(path, "file", entry.id);
        // Don't wake the editor — the session isn't bound yet. The
        // follow-up sessionReady refresh will wake it.
        return;
      }
      // Session is bound. Wake the editor so y-sync's update() fires
      // and rebinds (or no-ops if already bound to the right context).
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (cm && !wokenEditors.has(cm)) {
        wokenEditors.add(cm);
        this.wakeEditor(cm, path);
      }
    });

    // Notify LocalPresenceController of the currently-focused file.
    const activeFile = this.app.workspace.getActiveFile();
    const activePath =
      activeFile && activeFile.extension === "md" && this.manifestSync.getEntry(activeFile.path)?.kind === "file"
        ? activeFile.path
        : null;
    this.presence.setCurrentPath(activePath);

    // Log only when the set of seen paths changes — keeps log volume
    // sane during normal use.
    if (
      seenPaths.size !== this.knownPaths.size ||
      ![...seenPaths].every((p) => this.knownPaths.has(p))
    ) {
      log.info(
        "binding",
        `LiveViewManager.refresh: ${reason} (paths=${seenPaths.size}, active=${activePath ?? "(none)"})`,
      );
      this.knownPaths = seenPaths;
    }
  }

  // Dispatch a no-op transaction into the editor to force a fresh
  // update() cycle. yedit's plugins re-evaluate resolveContext at the
  // top of every update(); if the resolved context now differs from
  // what they're bound to, they rebind in place. This is the bridge
  // between "session became available" (no editor transaction) and
  // "yedit needs to notice".
  //
  // The transaction itself: no changes, no selection, no annotations
  // — just empty effects. CodeMirror still calls update() on it.
  // We use setTimeout(0) so we don't dispatch from inside the
  // workspace event callback that triggered this refresh (some
  // Obsidian versions reject reentrant dispatches).
  private wakeEditor(cm: EditorView, path: string): void {
    setTimeout(() => {
      if (this.destroyed) return;
      if (!cm.dom.isConnected) return;
      try {
        cm.dispatch({
          annotations: [yeditWake.of(true)],
        });
      } catch (err) {
        log.warn("binding", `wakeEditor dispatch failed for ${path}`, err);
      }
    }, 0);
  }

  // ── context resolver, called by yedit ──────────────────────────────

  // Read out of the EditorView's state via Obsidian's editorInfoField,
  // which gives us the TFile the view is currently displaying. Map to
  // the manifest entry; if there's a bound session for that path,
  // return its context.
  //
  // Hot path. Called on every observer body and every update() cycle
  // in y-sync / y-remote-selections.
  resolveContext(view: EditorView): YeditContext | null {
    let file: TFile | null = null;
    try {
      const info = view.state.field(editorInfoField, false);
      if (info && info.file instanceof TFile) {
        file = info.file;
      }
    } catch {
      return null;
    }
    if (!file) return null;
    if (file.extension !== "md") return null;
    const entry = this.manifestSync.getEntry(file.path);
    if (!entry || entry.kind !== "file") return null;
    const session = this.sessionManager.getBound(file.path);
    if (!session || session.sessionKind !== "file") return null;
    const text = session as unknown as TextSession;
    const awareness = text.provider.awareness;
    if (!awareness) return null;
    return {
      ytext: text.ytext,
      awareness,
      docId: text.docId,
      active: true,
      // Read-only copy of the local identity so y-remote-selections can
      // write a full { user, cursor } awareness state if it ever finds
      // the local state null. LocalPresenceController remains the owner
      // of identity; this is just a fallback so the editor's cursor
      // write can't advertise a nameless (or empty) state.
      user: this.presence.getUser(),
    };
  }

  // True if a CodeMirror editor is currently OPEN and showing this
  // markdown path in some workspace leaf. Used by ManifestSync's
  // background disk→Y capture to defer to the editor binding (yedit owns
  // disk↔Y for open files; the background diff path must not also fire,
  // or the two would fight). We probe the live workspace rather than the
  // diagnostics `knownPaths` set so the answer is always current — a
  // leaf can be open before any refresh has recorded it.
  hasEditorFor(path: string): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      const file = view.file;
      if (!(file instanceof TFile)) return;
      if (file.path !== path) return;
      // The leaf must actually have a live CodeMirror editor mounted
      // (source/live-preview). A pure reading-mode leaf has no editor
      // binding, so disk↔Y for it is NOT owned by yedit — in that case
      // the background path SHOULD run, so we report false.
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (cm && cm.dom.isConnected) found = true;
    });
    return found;
  }

  // ── teardown ───────────────────────────────────────────────────────

  destroy(): void {
    this.destroyed = true;
    for (const off of this.unsubs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.unsubs.length = 0;
    if (this.sessionReadyOff) {
      try {
        this.sessionReadyOff();
      } catch {
        /* ignore */
      }
      this.sessionReadyOff = null;
    }
    this.knownPaths.clear();
    log.info("binding", "LiveViewManager.destroy: done");
  }

  // Diagnostics.
  describe(): Array<{ path: string; bound: boolean }> {
    const out: Array<{ path: string; bound: boolean }> = [];
    for (const path of this.knownPaths) {
      out.push({ path, bound: this.sessionManager.getBound(path) !== null });
    }
    return out;
  }
}
