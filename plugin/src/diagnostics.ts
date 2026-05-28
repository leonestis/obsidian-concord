// SPDX-License-Identifier: AGPL-3.0-only
//
// Status bar + diagnostics command output. Two responsibilities:
//   1. Render a small status pill in the bottom-right ("🟢 collab live"
//      / "🔴 collab offline") with optional progress overlay
//      ("(uploading 42%)" or "(syncing 3/12 binaries)").
//   2. Surface "show diagnostics" command — connection state, active
//      sessions, editor binding sanity, manifest size.
//
// Status bar is desktop-only — Obsidian's mobile build doesn't expose
// addStatusBarItem. We feature-detect and fall back to silently
// no-oping (the connect/disconnect Notice on mobile is enough signal).

import { App, Notice, Plugin } from "obsidian";
import { log } from "./logger";
import type { SessionManager } from "./session-manager";
import type { LiveViewManager } from "./live-view-manager";
import type { LocalPresenceController } from "./local-presence";

export class StatusBar {
  private el: HTMLElement | null = null;
  private connected = false;
  private progressLabel: string | null = null;
  private serverUrl = "";
  // FIX A — persistent auth-failure indicator. When true it overrides
  // the connected/offline pill (a one-shot Notice disappears; the user
  // needs a standing reminder that sync is paused on a bad token).
  private authFailed = false;

  constructor(plugin: Plugin) {
    // addStatusBarItem returns undefined on mobile. Guard.
    try {
      const item = plugin.addStatusBarItem?.();
      if (item) this.el = item;
    } catch {
      this.el = null;
    }
  }

  setServerUrl(url: string) {
    this.serverUrl = url;
    this.render();
  }

  setConnected(c: boolean) {
    if (c === this.connected) return;
    this.connected = c;
    this.render();
  }

  setProgress(label: string | null) {
    this.progressLabel = label;
    this.render();
  }

  // FIX A — flip the persistent auth-failed indicator. Set true when
  // the server rejects the token, cleared on a recovery attempt
  // (token edit or explicit reconnect).
  setAuthFailed(failed: boolean) {
    if (failed === this.authFailed) return;
    this.authFailed = failed;
    this.render();
  }

  private render() {
    if (!this.el) return;
    if (this.authFailed) {
      // Persistent, unmissable state — no progress overlay, it's moot
      // while sync is paused.
      this.el.setText("⚠ collab auth failed — update token");
      this.el.setAttr(
        "title",
        `Server rejected the auth token. Open Collab settings and update your Auth token, or run “Reconnect to server”.\nServer: ${this.serverUrl}`,
      );
      return;
    }
    const dot = this.connected ? "🟢" : "🔴";
    const label = this.connected ? "collab live" : "collab offline";
    const progress = this.progressLabel ? ` (${this.progressLabel})` : "";
    this.el.setText(`${dot} ${label}${progress}`);
    this.el.setAttr("title", `Server: ${this.serverUrl}`);
  }
}

export function showDiagnostics(
  app: App,
  serverUrl: string,
  connected: boolean,
  sessionManager: SessionManager,
  manifestSize: number,
  liveViewManager?: LiveViewManager | null,
  presence?: LocalPresenceController | null,
): void {
  const lines: string[] = [];
  lines.push(`Server URL: ${serverUrl}`);
  lines.push(
    `Socket: ${connected ? "🟢 connected" : "🔴 disconnected"}`,
  );
  lines.push(`Read-only mode: ${sessionManager.isReadOnly() ? "yes" : "no"}`);
  lines.push(`Manifest entries: ${manifestSize}`);
  if (presence) {
    lines.push(`Presence: ${presence.describe()}`);
  }
  const sessions = sessionManager.describe();
  lines.push(`Sessions (${sessions.length}):`);
  for (const s of sessions) {
    lines.push(`  • ${s.path}  →  ${s.state}${s.docId ? "  [" + s.docId.slice(0, 8) + "…]" : ""}`);
  }
  if (liveViewManager) {
    const views = liveViewManager.describe();
    lines.push(`Live views (${views.length}):`);
    for (const v of views) {
      lines.push(`  • ${v.path}  →  bound=${v.bound}`);
    }
  }
  void app;
  const msg = lines.join("\n");
  log.info("diag", "diagnostics:\n" + msg);
  new Notice(msg, 15_000);
}
