// SPDX-License-Identifier: AGPL-3.0-only
//
// Collaborators presence panel — a right-sidebar ItemView listing who's
// collaborating: online peers (with the file they're in, clickable to
// jump there) and offline peers (with a relative "last seen").
//
// Pure read/render over PresenceController. It NEVER touches the
// content-sync machinery — it only reads getOnline() (manifest
// awareness) and getRosterEntries() (the roster Y.Map), and opens files
// via the public workspace API. Re-renders debounced on presence
// change + a 30s tick so relative times stay fresh.

import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type { PresenceController, PresenceState } from "./presence-controller";

export const COLLABORATORS_VIEW_TYPE = "collab-collaborators";

// Merged per-person online entry (one row even if the same person is
// connected from two devices — we union their platforms and prefer a
// non-null active file).
interface OnlineRow {
  presenceId: string;
  name: string;
  color: string;
  activeFile: string | null;
  platforms: Set<"desktop" | "mobile">;
  isSelf: boolean;
}

export class CollaboratorsView extends ItemView {
  private readonly getPresence: () => PresenceController | null;
  private unsub: (() => void) | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private renderQueued = false;

  constructor(
    leaf: WorkspaceLeaf,
    getPresence: () => PresenceController | null,
  ) {
    super(leaf);
    this.getPresence = getPresence;
  }

  getViewType(): string {
    return COLLABORATORS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Collaborators";
  }

  getIcon(): string {
    return "users";
  }

  async onOpen(): Promise<void> {
    const presence = this.getPresence();
    if (presence) {
      this.unsub = presence.onChange(() => this.queueRender());
    }
    // Keep relative "last seen" times fresh, and re-attach to presence
    // if it wasn't ready when the panel first opened (e.g. opened before
    // connect).
    this.tick = setInterval(() => {
      if (!this.unsub) {
        const p = this.getPresence();
        if (p) this.unsub = p.onChange(() => this.queueRender());
      }
      this.render();
    }, 30_000);
    this.render();
  }

  async onClose(): Promise<void> {
    if (this.unsub) {
      try {
        this.unsub();
      } catch {
        /* ignore */
      }
      this.unsub = null;
    }
    if (this.tick) {
      clearInterval(this.tick);
      this.tick = null;
    }
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setTimeout(() => {
      this.renderQueued = false;
      this.render();
    }, 100);
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("collab-collaborators");

    const presence = this.getPresence();
    if (!presence) {
      this.renderEmpty(root, "Not connected.");
      return;
    }

    // ── Online: merge per presenceId ────────────────────────────────
    const onlineById = new Map<string, OnlineRow>();
    for (const p of presence.getOnline()) {
      const existing = onlineById.get(p.presenceId);
      if (existing) {
        existing.platforms.add(p.platform);
        if (!existing.activeFile && p.activeFile) existing.activeFile = p.activeFile;
        existing.isSelf = existing.isSelf || p.isSelf;
      } else {
        onlineById.set(p.presenceId, {
          presenceId: p.presenceId,
          name: p.name,
          color: p.color,
          activeFile: p.activeFile,
          platforms: new Set<"desktop" | "mobile">([p.platform]),
          isSelf: p.isSelf,
        });
      }
    }
    const online = Array.from(onlineById.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    // ── Offline: roster entries not currently online ────────────────
    const onlineIds = new Set(onlineById.keys());
    const offline = presence
      .getRosterEntries()
      .filter((r) => !onlineIds.has(r.presenceId))
      .sort((a, b) => b.lastSeen - a.lastSeen);

    if (online.length === 0 && offline.length === 0) {
      this.renderEmpty(root, "No collaborators yet.");
      return;
    }

    // ── Online section ──────────────────────────────────────────────
    if (online.length > 0) {
      this.sectionHeader(root, `Online — ${online.length}`);
      for (const row of online) this.renderOnlineRow(root, row);
    }

    // ── Offline section ─────────────────────────────────────────────
    if (offline.length > 0) {
      this.sectionHeader(root, "Offline");
      for (const r of offline) this.renderOfflineRow(root, r);
    }
  }

  private renderEmpty(root: HTMLElement, text: string): void {
    const el = root.createDiv({ cls: "collab-collaborators-empty" });
    el.setText(text);
  }

  private sectionHeader(root: HTMLElement, text: string): void {
    root.createDiv({ cls: "collab-collaborators-section", text });
  }

  private avatar(parent: HTMLElement, name: string, color: string, online: boolean): void {
    const av = parent.createDiv({ cls: "collab-collaborators-avatar" });
    av.style.backgroundColor = color || "#888";
    av.setText((name || "?").trim().charAt(0).toUpperCase() || "?");
    if (!online) av.addClass("is-offline");
  }

  private renderOnlineRow(root: HTMLElement, row: OnlineRow): void {
    const el = root.createDiv({ cls: "collab-collaborators-row is-online" });
    this.avatar(el, row.name, row.color, true);

    const body = el.createDiv({ cls: "collab-collaborators-body" });
    const nameLine = body.createDiv({ cls: "collab-collaborators-name" });
    nameLine.setText(row.name || "anonymous");
    if (row.isSelf) {
      nameLine.createSpan({ cls: "collab-collaborators-you", text: " (you)" });
    }
    // Platform glyph(s).
    for (const plat of row.platforms) {
      const g = nameLine.createSpan({ cls: "collab-collaborators-plat" });
      setIcon(g, plat === "mobile" ? "smartphone" : "monitor");
    }

    const sub = body.createDiv({ cls: "collab-collaborators-sub" });
    if (row.activeFile) {
      const link = sub.createSpan({ cls: "collab-collaborators-file" });
      const fg = link.createSpan({ cls: "collab-collaborators-fileicon" });
      setIcon(fg, "file-text");
      link.createSpan({ text: this.basename(row.activeFile) });
      link.setAttr("title", `Open ${row.activeFile}`);
      // Click row OR link → open the file the peer is in.
      const open = () => this.openPath(row.activeFile!);
      link.addEventListener("click", (e) => {
        e.stopPropagation();
        open();
      });
      el.addClass("is-clickable");
      el.addEventListener("click", open);
    } else {
      sub.setText("idle");
      sub.addClass("is-muted");
    }

    // Online dot.
    el.createDiv({ cls: "collab-collaborators-dot is-online" });
  }

  private renderOfflineRow(
    root: HTMLElement,
    r: { name: string; color: string; lastSeen: number },
  ): void {
    const el = root.createDiv({ cls: "collab-collaborators-row is-offline" });
    this.avatar(el, r.name, r.color, false);
    const body = el.createDiv({ cls: "collab-collaborators-body" });
    body.createDiv({ cls: "collab-collaborators-name", text: r.name || "anonymous" });
    const sub = body.createDiv({ cls: "collab-collaborators-sub is-muted" });
    sub.setText(`offline · ${this.relativeTime(r.lastSeen)}`);
    el.createDiv({ cls: "collab-collaborators-dot is-offline" });
  }

  private basename(path: string): string {
    const slash = path.lastIndexOf("/");
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    return name.replace(/\.md$/, "");
  }

  private async openPath(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      // Not present locally (shouldn't happen with whole-vault sync) —
      // fall back to link resolution.
      void this.app.workspace.openLinkText(path, "", false);
      return;
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  // "just now" / "5m ago" / "3h ago" / "2d ago".
  private relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 0) return "just now";
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    return `${day}d ago`;
  }
}
