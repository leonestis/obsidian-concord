// SPDX-License-Identifier: AGPL-3.0-only
//
// obsidian-collab plugin, v1.0.0.
//
// This file is the orchestrator: settings, command palette, vault
// event wiring, socket lifecycle. Per-file CRDT logic lives in
// session-manager.ts + text/canvas/atomic-text-session.ts; manifest
// sync lives in manifest-sync.ts; HTTP blob client lives in
// binary-client.ts. The canvas presence layer (canvas-cursors.ts)
// and the editor↔Y.Text binding (collab-binding.ts) are unchanged
// from 0.9.x — both are solid and the task brief explicitly forbids
// touching them.

import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
} from "obsidian";
import { Compartment } from "@codemirror/state";
import { HocuspocusProviderWebsocket } from "@hocuspocus/provider";

import { BinaryClient } from "./binary-client";
import { ManifestSync } from "./manifest-sync";
import { SessionManager } from "./session-manager";
import { TrashModal } from "./trash";
import { StatusBar, showDiagnostics } from "./diagnostics";
import { log } from "./logger";
import {
  PLUGIN_VERSION,
} from "./types";
import {
  colorFromName,
  deriveBlobUrl,
  randomName,
} from "./util";

interface CollabSettings {
  serverUrl: string;
  // Optional override. Empty string → derived from serverUrl.
  blobServerUrl: string;
  authToken: string;
  userName: string;
  userColor: string;
  autoConnect: boolean;
  // When true, every Y.Text delta etc is printed to the dev console.
  // Off by default — those lines contain the user's notes. Errors,
  // warnings and lifecycle events are always logged.
  debugLogging: boolean;
}

const DEFAULT_SETTINGS: CollabSettings = {
  serverUrl: "",
  blobServerUrl: "",
  authToken: "",
  userName: "",
  userColor: "",
  autoConnect: true,
  debugLogging: false,
};

export default class CollabPlugin extends Plugin {
  settings!: CollabSettings;

  private socket: HocuspocusProviderWebsocket | null = null;
  private connected = false;
  private statusBar!: StatusBar;
  private manifestSync!: ManifestSync;
  private sessionManager!: SessionManager;
  private binaryClient: BinaryClient | null = null;
  private readonly editorCompartment = new Compartment();

  // Refcounted suppression — see the long-form comment in 0.9.x main.ts.
  // Each `add(path)` MUST be paired with one `delete(path)`. Internally
  // a Map counts references so concurrent operations on the same path
  // don't clobber each other's cleanup.
  private remoteApplyPathCounts = new Map<string, number>();
  private readonly remoteApplyPaths = {
    add: (p: string) => {
      this.remoteApplyPathCounts.set(
        p,
        (this.remoteApplyPathCounts.get(p) ?? 0) + 1,
      );
    },
    delete: (p: string) => {
      const next = (this.remoteApplyPathCounts.get(p) ?? 0) - 1;
      if (next <= 0) this.remoteApplyPathCounts.delete(p);
      else this.remoteApplyPathCounts.set(p, next);
    },
    has: (p: string): boolean =>
      (this.remoteApplyPathCounts.get(p) ?? 0) > 0,
  };

  async onload(): Promise<void> {
    await this.loadSettings();
    log.info("plugin", `v${PLUGIN_VERSION} loaded`);

    this.addSettingTab(new CollabSettingTab(this.app, this));
    this.statusBar = new StatusBar(this);
    this.statusBar.setServerUrl(this.settings.serverUrl);

    this.registerEditorExtension(this.editorCompartment.of([]));

    this.sessionManager = new SessionManager({
      app: this.app,
      editorCompartment: this.editorCompartment,
      getSocket: () => this.socket,
      serverUrl: () => this.settings.serverUrl,
      authToken: () => this.settings.authToken || undefined,
      user: () => ({
        name: this.settings.userName,
        color: this.settings.userColor,
      }),
      remoteApplyPaths: this.remoteApplyPaths,
      debug: (...a) => this.debug(...a),
    });

    this.manifestSync = new ManifestSync({
      app: this.app,
      serverUrl: () => this.settings.serverUrl,
      authToken: () => this.settings.authToken || undefined,
      getSocket: () => this.socket,
      sessionManager: this.sessionManager,
      binaryClient: () => this.binaryClient,
      remoteApplyPaths: this.remoteApplyPaths,
      onDownloadProgress: (label) => this.statusBar.setProgress(label),
      debug: (...a) => this.debug(...a),
    });

    this.addCommand({
      id: "collab-reconnect",
      name: "Reconnect to server",
      callback: () => void this.reconnect(),
    });
    this.addCommand({
      id: "collab-show-status",
      name: "Show connection status (diagnostics)",
      callback: () =>
        showDiagnostics(
          this.app,
          this.settings.serverUrl,
          this.connected,
          this.sessionManager,
          this.manifestSync.isReady() ? -1 : 0,
        ),
    });
    this.addCommand({
      id: "collab-show-trash",
      name: "Show deleted files (trash)",
      callback: () => this.openTrashModal(),
    });
    this.addCommand({
      id: "collab-wipe-local-cache",
      name: "Wipe local cache (IndexedDB)",
      callback: () => this.openWipeCacheModal(),
    });

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file || file.extension !== "md") return;
        void this.handleMarkdownFileOpen(file.path);
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) =>
        void this.manifestSync.onLocalRename(file, oldPath),
      ),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) =>
        void this.manifestSync.onLocalDelete(file),
      ),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) =>
        this.manifestSync.onLocalCreate(file),
      ),
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) =>
        this.manifestSync.onLocalModify(file),
      ),
    );

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoConnect) this.connect();
    });
  }

  async onunload(): Promise<void> {
    log.info("plugin", "unloading…");
    // Optional-chain everything: onunload runs even when onload
    // failed partway, in which case manifestSync / sessionManager
    // may never have been constructed. A throw here cascades into
    // Obsidian's plugin-unload pipeline and surfaces as a second
    // confusing error stacked on the first.
    try {
      await this.manifestSync?.stop();
    } catch (err) {
      log.warn("plugin", "manifestSync.stop failed during unload", err);
    }
    try {
      await this.sessionManager?.destroyAll();
    } catch (err) {
      log.warn("plugin", "sessionManager.destroyAll failed during unload", err);
    }
    this.socket?.destroy();
    this.socket = null;
    log.info("plugin", "unloaded");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.userName) this.settings.userName = randomName();
    if (!this.settings.userColor) {
      this.settings.userColor = colorFromName(this.settings.userName);
    }
    await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Guard: saveSettings is called from loadSettings (during onload,
    // before statusBar/binaryClient exist) and from the settings tab
    // (after both exist). Optional-chain so the first-time call
    // doesn't crash the plugin's whole load. onload's own
    // statusBar.setServerUrl() right after construction picks up the
    // server URL when statusBar is finally available.
    this.statusBar?.setServerUrl(this.settings.serverUrl);
    // Update binary client baseUrl + token in case settings changed
    // mid-session.
    this.binaryClient = this.makeBinaryClient();
  }

  private debug(...args: unknown[]): void {
    if (this.settings?.debugLogging) console.log(...args);
  }

  // file-open handler for markdown files. Drives auto-attach for any
  // .md file whose manifest entry exists locally (e.g. created by a
  // peer and materialised by the manifest observer) but whose
  // SessionManager session was never opened — without this we'd leave
  // the editor unbound and silently swallow every keystroke. The
  // attach() call is idempotent for already-bound sessions, so calling
  // it on every open is safe; if no manifest entry exists yet (brand
  // new file) we bail out and let onLocalCreate (vault.create event)
  // do the work.
  private async handleMarkdownFileOpen(path: string): Promise<void> {
    const entry = this.manifestSync.getEntry(path);
    if (entry && entry.kind === "file") {
      log.info("binding", `file-open ${path} → attach(docId=${entry.id})`);
      await this.sessionManager.attach(path, "file", entry.id);
    }
    await this.sessionManager.bindEditorIfReady(path);
    this.sessionManager.awarenessHandoffTo(path);
  }

  private blobBaseUrl(): string {
    const override = this.settings.blobServerUrl.trim();
    if (override.length > 0) return override.replace(/\/+$/, "");
    return deriveBlobUrl(this.settings.serverUrl).replace(/\/+$/, "");
  }

  private makeBinaryClient(): BinaryClient {
    return new BinaryClient(
      this.blobBaseUrl(),
      this.settings.authToken || undefined,
      (msg) => new Notice(msg, 12_000),
    );
  }

  // ── connection lifecycle ────────────────────────────────────────────

  private connect(): void {
    if (this.socket) return;
    const trimmed = this.settings.serverUrl.trim();
    if (!trimmed) {
      // New users with empty serverUrl shouldn't get a connect storm
      // or a cryptic socket error — surface the missing setting once.
      log.info("socket", "connect skipped: Server URL is empty");
      new Notice(
        "Collab: Server URL not configured. Open settings to enter your server's WebSocket URL.",
        8000,
      );
      return;
    }
    try {
      const baseUrl = trimmed.replace(/\/+$/, "");
      const sep = baseUrl.includes("?") ? "&" : "?";
      this.socket = new HocuspocusProviderWebsocket({
        url: `${baseUrl}${sep}clientVersion=${encodeURIComponent(PLUGIN_VERSION)}`,
      });
      this.binaryClient = this.makeBinaryClient();
      this.socket.on("status", (event: { status: string }) => {
        log.info("socket", `status: ${event.status}`);
        this.connected = event.status === "connected";
        this.statusBar.setConnected(this.connected);
      });
      this.socket.on("close", (event: unknown) => {
        log.info("socket", "close", event);
      });
      this.manifestSync.start();
      // If a markdown file is already open, bind it lazily — manifest
      // sync's reconcile will create the session and the editor
      // binding will follow on the next file-open / bindEditorIfReady.
    } catch (err) {
      log.error("socket", "failed to open socket", err);
      new Notice("Collab: failed to connect — see console");
    }
  }

  private async reconnect(): Promise<void> {
    await this.manifestSync.stop();
    await this.sessionManager.destroyAll();
    this.socket?.destroy();
    this.socket = null;
    this.binaryClient = null;
    this.connected = false;
    this.statusBar.setConnected(false);
    this.connect();
    new Notice("Collab: reconnected");
  }

  // ── trash ───────────────────────────────────────────────────────────

  private openTrashModal(): void {
    const trash = this.manifestSync.getTrash();
    if (!trash) {
      new Notice("Collab: not connected — open trash after socket connects");
      return;
    }
    new TrashModal(this.app, trash).open();
  }

  // ── local cache wipe ────────────────────────────────────────────────

  private openWipeCacheModal(): void {
    new WipeCacheModal(this.app, this.settings.serverUrl, () =>
      this.performWipeLocalCache(),
    ).open();
  }

  private async performWipeLocalCache(): Promise<void> {
    log.info("plugin", "performWipeLocalCache: starting");
    await this.manifestSync.stop();
    await this.sessionManager.destroyAll();
    this.socket?.destroy();
    this.socket = null;
    this.binaryClient = null;
    this.connected = false;
    this.statusBar.setConnected(false);
    await new Promise<void>((r) => setTimeout(r, 200));

    const prefix = `obsidian-collab::${this.settings.serverUrl}::`;
    const idb = indexedDB as unknown as {
      databases?: () => Promise<Array<{ name?: string }>>;
    };
    if (typeof idb.databases !== "function") {
      log.warn(
        "plugin",
        "performWipeLocalCache: indexedDB.databases() unavailable (Firefox?)",
      );
      new Notice(
        "Collab: cannot enumerate IndexedDB on this browser. Open DevTools → Application → IndexedDB and delete entries starting with " +
          prefix,
        15_000,
      );
      this.connect();
      return;
    }

    let dbs: Array<{ name?: string }>;
    try {
      dbs = await idb.databases();
    } catch (err) {
      log.warn("plugin", "performWipeLocalCache: databases() threw", err);
      new Notice("Collab: failed to enumerate IndexedDB — see console");
      this.connect();
      return;
    }
    const targets = dbs
      .map((d) => d.name)
      .filter((n): n is string => typeof n === "string" && n.startsWith(prefix));
    log.info(
      "plugin",
      `performWipeLocalCache: found ${targets.length} databases to drop`,
    );
    let deleted = 0;
    for (const name of targets) {
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => {
          deleted++;
          log.info("plugin", `performWipeLocalCache: deleted ${name}`);
          resolve();
        };
        req.onerror = () => {
          log.warn(
            "plugin",
            `performWipeLocalCache: failed to delete ${name}`,
            req.error,
          );
          resolve();
        };
        req.onblocked = () => {
          log.warn(
            "plugin",
            `performWipeLocalCache: delete blocked for ${name}`,
          );
          resolve();
        };
      });
    }
    new Notice(
      `Collab: wiped ${deleted}/${targets.length} local cache database(s). Reconnecting…`,
      8000,
    );
    log.info(
      "plugin",
      `performWipeLocalCache: complete (${deleted}/${targets.length})`,
    );
    this.connect();
  }
}

// ── settings tab ───────────────────────────────────────────────────────

class CollabSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: CollabPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Collab settings" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("WebSocket URL of the Hocuspocus server (ws:// or wss://).")
      .addText((text) =>
        text
          .setPlaceholder("ws://your-server.example.com:1234")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Blob server URL (override)")
      .setDesc(
        "HTTP base URL for binary file storage. Leave empty to derive from Server URL (ws:// → http://, same port). Set explicitly only if blobs live on a different host or behind a different reverse proxy.",
      )
      .addText((text) =>
        text
          .setPlaceholder("http://your-server.example.com:1234")
          .setValue(this.plugin.settings.blobServerUrl)
          .onChange(async (value) => {
            this.plugin.settings.blobServerUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auth token")
      .setDesc(
        "JWT token issued by the server admin. Used for BOTH the WebSocket and the blob HTTP endpoints. Leave empty if the server runs without auth.",
      )
      .addText((text) =>
        text
          .setPlaceholder("eyJhbGciOi...")
          .setValue(this.plugin.settings.authToken)
          .onChange(async (value) => {
            this.plugin.settings.authToken = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Display name")
      .setDesc("Shown above your cursor to other editors.")
      .addText((text) =>
        text
          .setPlaceholder("alex")
          .setValue(this.plugin.settings.userName)
          .onChange(async (value) => {
            this.plugin.settings.userName = value.trim() || randomName();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Cursor color")
      .addColorPicker((picker) =>
        picker
          .setValue(this.plugin.settings.userColor)
          .onChange(async (value) => {
            this.plugin.settings.userColor = value;
            await this.plugin.saveSettings();
          }),
      )
      .addExtraButton((btn) =>
        btn
          .setIcon("reset")
          .setTooltip("Reset color to auto-pick from display name")
          .onClick(async () => {
            this.plugin.settings.userColor = colorFromName(
              this.plugin.settings.userName,
            );
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc(
        "Print every Y.Text delta and remote event to the dev console. Lines contain note content — leave off during screen-shares.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-connect on startup")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoConnect)
          .onChange(async (value) => {
            this.plugin.settings.autoConnect = value;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        'Changes take effect on next reconnect. Use the command palette → "Collab: Reconnect to server" to apply now.',
    });
  }
}

// ── wipe-cache modal ───────────────────────────────────────────────────

class WipeCacheModal extends Modal {
  constructor(
    app: App,
    private readonly serverUrl: string,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Wipe local cache?" });
    contentEl.createEl("p", {
      text:
        "This will disconnect, delete all locally cached collab data for " +
        this.serverUrl +
        ", and reconnect with a fresh local state. Vault files on disk are not touched. Proceed?",
    });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    const confirmBtn = buttons.createEl("button", {
      text: "Wipe",
      cls: "mod-warning",
    });
    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      try {
        await this.onConfirm();
      } finally {
        this.close();
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Unused but referenced — keeps the type checker happy if anything imports it.
export type { TAbstractFile, TFile };
