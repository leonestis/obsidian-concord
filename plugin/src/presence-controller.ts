// SPDX-License-Identifier: AGPL-3.0-only
//
// PresenceController — the data layer for the Collaborators sidebar.
//
// This is a NEW, ISOLATED presence feature. It is READ-MOSTLY and rides
// the manifest room's AWARENESS (the always-on global channel) plus a
// NEW `roster` Y.Map for offline last-seen tracking. It NEVER touches the
// content-sync machinery (files/trash/meta maps, sessions, ytext, canvas).
//
// Responsibilities:
//   1. Publish the local user's presence into the manifest provider's
//      awareness under a dedicated `presence` field:
//        { presenceId, name, color, activeFile, platform, clientId }
//      Updated whenever the active markdown/canvas file changes (hooked
//      to the same workspace events LiveViewManager uses) and on
//      name/color (settings) changes.
//   2. Keep the local user's roster entry fresh (upsert lastSeen) on
//      connect and on every activeFile change, so peers see us in the
//      offline list with a recent "last seen" after we disconnect.
//   3. Notify subscribers (the panel) on any awareness `change` or roster
//      `observe`, so the panel can re-render.
//
// Identity (presenceId) is owned by plugin settings (main.ts) — a stable
// uuid persisted in data.json so renames don't create duplicate rows.
//
// The local awareness `presence` field lives ALONGSIDE the per-file
// cursor awareness that the editor writes into the per-file rooms — they
// are different awareness instances (manifest room vs doc:<id> room), so
// there is zero interference.

import { App, MarkdownView, Platform, TFile } from "obsidian";
import type { Awareness } from "y-protocols/awareness";

import { log } from "./logger";
import type { ManifestSync } from "./manifest-sync";

// The shape we publish into the manifest awareness under the `presence`
// key. clientId is the awareness clientID (numeric), used to dedupe the
// local entry and to look up the peer's per-file cursor later.
export interface PresenceState {
  presenceId: string;
  name: string;
  color: string;
  activeFile: string | null;
  platform: "desktop" | "mobile";
}

export interface PresenceControllerDeps {
  app: App;
  manifestSync: ManifestSync;
  presenceId: () => string;
  user: () => { name: string; color: string };
}

export class PresenceController {
  private readonly app: App;
  private readonly manifestSync: ManifestSync;
  private readonly getPresenceId: () => string;
  private readonly getUser: () => { name: string; color: string };

  private activeFile: string | null = null;

  // Workspace event unsubscribers + awareness/roster listeners.
  private unsubs: Array<() => void> = [];
  private awarenessHandler: (() => void) | null = null;
  private rosterObserver: (() => void) | null = null;
  private boundAwareness: Awareness | null = null;
  private boundRoster: ReturnType<ManifestSync["getRoster"]> | null = null;

  // Subscribers (the panel) notified on any presence/roster change.
  private listeners: Array<() => void> = [];

  private started = false;

  constructor(deps: PresenceControllerDeps) {
    this.app = deps.app;
    this.manifestSync = deps.manifestSync;
    this.getPresenceId = deps.presenceId;
    this.getUser = deps.user;

    const ws = this.app.workspace;
    const reg = (ref: ReturnType<typeof ws.on>) => {
      this.unsubs.push(() => ws.offref(ref));
    };
    // Same events LiveViewManager hooks — recompute the active file and
    // republish presence whenever the workspace focus shifts.
    reg(ws.on("active-leaf-change", () => this.refreshActiveFile()));
    reg(ws.on("file-open", () => this.refreshActiveFile()));
    reg(ws.on("layout-change", () => this.refreshActiveFile()));
  }

  // Subscribe to "something changed" (awareness or roster). Returns an
  // unsubscribe function. The panel uses this to drive a debounced
  // re-render.
  onChange(cb: () => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private emitChange(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (err) {
        log.warn("presence", "onChange listener threw", err);
      }
    }
  }

  private platform(): "desktop" | "mobile" {
    return Platform.isMobile ? "mobile" : "desktop";
  }

  // Bind to the manifest awareness + roster. Idempotent and safe to call
  // when the manifest isn't ready yet (it retries via the panel's
  // refresh loop / next workspace event). Call after connect.
  start(): void {
    const awareness = this.manifestSync.getPresenceAwareness();
    const roster = this.manifestSync.getRoster();
    if (!awareness || !roster) {
      // Manifest not connected yet — nothing to bind. The panel's
      // periodic refresh + the next workspace event will re-attempt.
      return;
    }
    // Already bound to this exact awareness/roster — no-op.
    if (this.boundAwareness === awareness && this.boundRoster === roster) {
      // Still refresh our published state in case user/file changed.
      this.publish();
      return;
    }
    // Rebind (e.g. after a reconnect created a fresh provider/doc).
    this.unbind();
    this.boundAwareness = awareness;
    this.boundRoster = roster;

    this.awarenessHandler = () => this.emitChange();
    awareness.on("change", this.awarenessHandler);

    this.rosterObserver = () => this.emitChange();
    roster.observe(this.rosterObserver);

    this.started = true;
    this.refreshActiveFile();
    this.publish();
    this.upsertRoster();
    log.info("presence", "PresenceController started");
  }

  // Recompute the active file from the workspace. Markdown + canvas
  // count; anything else (or no leaf) → null. Republishes + refreshes
  // the roster lastSeen only when the file actually changed.
  private refreshActiveFile(): void {
    const file = this.app.workspace.getActiveFile();
    let next: string | null = null;
    if (file instanceof TFile) {
      if (file.extension === "md" || file.extension === "canvas") {
        next = file.path;
      }
    }
    // Reading-mode / non-file leaves: getActiveFile can still return the
    // backing file, which is what we want ("in: <file>"). If there's no
    // active markdown/canvas file, go idle (null).
    void this.app.workspace.getActiveViewOfType(MarkdownView);
    if (next === this.activeFile) return;
    this.activeFile = next;
    this.publish();
    this.upsertRoster();
    this.emitChange();
  }

  // Write our presence into the manifest awareness under `presence`.
  // setLocalStateField touches ONLY the `presence` key — it does not
  // disturb any other awareness field, and awareness is a separate
  // channel from the doc content entirely.
  private publish(): void {
    if (!this.boundAwareness) return;
    const user = this.getUser();
    const state: PresenceState = {
      presenceId: this.getPresenceId(),
      name: user.name,
      color: user.color,
      activeFile: this.activeFile,
      platform: this.platform(),
    };
    try {
      this.boundAwareness.setLocalStateField("presence", state);
    } catch (err) {
      log.warn("presence", "publish failed", err);
    }
  }

  // Upsert our roster entry (lastSeen = now). Touches ONLY the roster map.
  private upsertRoster(): void {
    const user = this.getUser();
    const id = this.getPresenceId();
    if (!id) return;
    this.manifestSync.upsertRoster(id, user.name, user.color);
  }

  // Called from main.ts on settings change (name/color). Republish + bump
  // the roster so peers see the new identity immediately.
  onUserChanged(): void {
    if (!this.started) return;
    this.publish();
    this.upsertRoster();
    this.emitChange();
  }

  // Read the current online peers + self from the manifest awareness.
  // Returns one entry per awareness client that has published a
  // `presence` field. Includes the local user.
  getOnline(): Array<PresenceState & { clientId: number; isSelf: boolean }> {
    const awareness = this.boundAwareness;
    if (!awareness) return [];
    const localClientId = awareness.clientID;
    const out: Array<PresenceState & { clientId: number; isSelf: boolean }> = [];
    awareness.getStates().forEach((raw, clientId) => {
      const p = (raw as { presence?: PresenceState } | undefined)?.presence;
      if (!p || typeof p.presenceId !== "string") return;
      out.push({ ...p, clientId, isSelf: clientId === localClientId });
    });
    return out;
  }

  // The local awareness clientID (or null if not bound). The panel uses
  // it to flag "you".
  localClientId(): number | null {
    return this.boundAwareness?.clientID ?? null;
  }

  // The roster map snapshot (presenceId → entry). Read-only view.
  getRosterEntries(): Array<{ presenceId: string; name: string; color: string; lastSeen: number }> {
    const roster = this.boundRoster;
    if (!roster) return [];
    const out: Array<{ presenceId: string; name: string; color: string; lastSeen: number }> = [];
    for (const [presenceId, entry] of roster.entries()) {
      out.push({ presenceId, name: entry.name, color: entry.color, lastSeen: entry.lastSeen });
    }
    return out;
  }

  // Remove every roster entry that is NOT currently online (the "Offline"
  // list). Online peers re-upsert themselves, so they're untouched. The
  // roster is a synced Y.Map, so this clears the offline list for ALL
  // peers. Returns how many were removed. Used by the "Clear offline
  // collaborators" command/button to drop stale identities (e.g. an old
  // random `user-XXXX` name from a previous rename).
  clearOffline(): number {
    const roster = this.boundRoster;
    if (!roster) return 0;
    const online = new Set<string>();
    const awareness = this.boundAwareness;
    if (awareness) {
      awareness.getStates().forEach((raw) => {
        const p = (raw as { presence?: PresenceState } | undefined)?.presence;
        if (p && typeof p.presenceId === "string") online.add(p.presenceId);
      });
    }
    let removed = 0;
    for (const id of Array.from(roster.keys())) {
      if (!online.has(id)) {
        roster.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.emitChange();
    return removed;
  }

  // Detach awareness/roster listeners. Does NOT clear the published
  // presence — call clearPresence() for that (on plugin unload).
  private unbind(): void {
    if (this.boundAwareness && this.awarenessHandler) {
      try {
        this.boundAwareness.off("change", this.awarenessHandler);
      } catch {
        /* ignore */
      }
    }
    this.awarenessHandler = null;
    if (this.boundRoster && this.rosterObserver) {
      try {
        this.boundRoster.unobserve(this.rosterObserver);
      } catch {
        /* ignore */
      }
    }
    this.rosterObserver = null;
    this.boundAwareness = null;
    this.boundRoster = null;
  }

  // Clear our published presence so peers see us go offline promptly.
  // Best-effort: only the `presence` field is removed; we leave any other
  // awareness state untouched. (The manifest awareness has no other
  // local field, but be conservative.)
  clearPresence(): void {
    const awareness = this.boundAwareness;
    if (!awareness) return;
    try {
      awareness.setLocalStateField("presence", null);
    } catch (err) {
      log.warn("presence", "clearPresence failed", err);
    }
  }

  // Full teardown on plugin unload.
  destroy(): void {
    this.clearPresence();
    this.unbind();
    for (const off of this.unsubs) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.unsubs.length = 0;
    this.listeners.length = 0;
    this.started = false;
  }
}
