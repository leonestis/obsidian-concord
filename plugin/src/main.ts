// SPDX-License-Identifier: AGPL-3.0-only
//
// obsidian-collab plugin, v2.0.0.
//
// This file is the orchestrator: settings, command palette, vault
// event wiring, socket lifecycle. v2.0.0 collapsed editor binding into
// three new modules — yedit/ (vendored y-codemirror.next), local-
// presence.ts (single source of truth for awareness state) and live-
// view-manager.ts (one LiveView per markdown leaf, single-flight
// refresh queue). The Compartment that v1.x mounted as an editor
// extension is gone; each LiveView holds its own per-leaf compartment.
//
// Per-file CRDT logic still lives in session-manager.ts +
// text/canvas/atomic-text-session.ts; manifest sync in manifest-sync.ts;
// HTTP blob client in binary-client.ts. Canvas presence
// (canvas-cursors.ts + canvas-session.ts) is unchanged from 0.9.x and
// remains outside the v2.0.0 surface.

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
import { HocuspocusProviderWebsocket } from "@hocuspocus/provider";

import { BinaryClient } from "./binary-client";
import { ManifestSync } from "./manifest-sync";
import { SessionManager } from "./session-manager";
import { LocalPresenceController } from "./local-presence";
import { LiveViewManager } from "./live-view-manager";
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
  // FIX A — set when the server rejects our auth handshake. While true,
  // we stop the websocket's reconnect loop (storm) and refuse to
  // auto-connect; only an explicit token change or the "Reconnect"
  // command clears it and tries a fresh socket. Persisted only in
  // memory — a plugin reload re-attempts the connection from scratch.
  private authFailed = false;
  // Last auth token we've seen in saveSettings. Used to detect "the
  // user edited the token" so an auth-failed session can auto-recover
  // the moment a new token is typed (FIX A recovery), without making
  // every unrelated settings change kick a reconnect.
  private lastAuthToken = "";
  private statusBar!: StatusBar;
  private manifestSync!: ManifestSync;
  private sessionManager!: SessionManager;
  private presence!: LocalPresenceController;
  private liveViewManager!: LiveViewManager;
  private binaryClient: BinaryClient | null = null;

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

    // v2.0.0 construction order: SessionManager → ManifestSync → wire
    // sessionReady event → LocalPresenceController (needs SessionManager
    // for boundMarkdownSessions iterator) → LiveViewManager (needs
    // everything else). The plugin no longer mounts a global editor
    // extension via registerEditorExtension; each LiveView owns its own
    // per-leaf Compartment and reconfigures only the editor it's
    // attached to.

    this.sessionManager = new SessionManager({
      app: this.app,
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
      onAuthFailed: (reason) => this.handleAuthFailure(reason),
      // Lazy: liveViewManager is constructed AFTER manifestSync (below),
      // so resolve it at call time. Default to "editor open" (defer
      // background capture) until it exists — the safe branch.
      hasEditorFor: (path) =>
        this.liveViewManager
          ? this.liveViewManager.hasEditorFor(path)
          : true,
      debug: (...a) => this.debug(...a),
    });

    // Wire SessionManager → ManifestSync's emitter so every successful
    // attach() fires sessionReady for the listeners (LiveViewManager).
    this.sessionManager.setSessionReadyEmitter((path) => {
      this.manifestSync.emitSessionReady(path);
    });

    this.presence = new LocalPresenceController(this.sessionManager, {
      name: this.settings.userName,
      color: this.settings.userColor,
    });

    this.liveViewManager = new LiveViewManager({
      app: this.app,
      sessionManager: this.sessionManager,
      manifestSync: this.manifestSync,
      presence: this.presence,
    });

    // Install the global editor extension. Applied to every CodeMirror
    // editor Obsidian opens, including markdown views opened later in
    // the session. The extension is stable across file switches — the
    // SAME ViewPlugin instances handle every editor, and they resolve
    // ytext + awareness dynamically per-view via the Facet's
    // resolveContext function (which routes to LiveViewManager).
    this.registerEditorExtension(this.liveViewManager.editorExtension());

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
          this.liveViewManager,
          this.presence,
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

    // v2.0.0: LiveViewManager subscribes to workspace 'file-open' /
    // 'active-leaf-change' / 'layout-change' itself in its constructor.
    // The old handleMarkdownFileOpen pipeline (attach + bindEditorIfReady
    // + awarenessHandoffTo) was the source of every double-bind and
    // awareness-drop bug from v1.0.0 through v1.0.5. It's gone. The
    // event subscriptions below cover everything else (rename / delete
    // / create / modify dispatched into manifest-sync).
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
    // failed partway, in which case constructed objects may never have
    // been assigned. A throw here cascades into Obsidian's plugin-
    // unload pipeline and surfaces as a second confusing error stacked
    // on the first.
    //
    // Order: LiveViewManager first (detaches every leaf's compartment
    // so editors stop dispatching into a destroying Y.Text), then
    // ManifestSync.stop (idempotent), then SessionManager.destroyAll
    // (which removes our awareness state from every room so peers
    // see us go offline immediately, not after a 30s heartbeat).
    try {
      this.liveViewManager?.destroy();
    } catch (err) {
      log.warn("plugin", "liveViewManager.destroy failed during unload", err);
    }
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
    // Seed the token tracker BEFORE the saveSettings() below, so the
    // first save (during onload, when we haven't even connected yet)
    // doesn't read as a "token changed" event and trigger a spurious
    // reconnect. FIX A recovery only fires on genuine later edits.
    this.lastAuthToken = this.settings.authToken;
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
    // v2.0.0: presence is the single source of truth for user identity
    // across every bound session. Push the latest values whenever
    // settings change so peers see name / color updates without a
    // reconnect.
    this.presence?.setUser({
      name: this.settings.userName,
      color: this.settings.userColor,
    });
    // FIX A recovery — if the user edited the auth token while we were
    // in the auth-failed state, treat it as "I fixed it": clear the
    // gate and rebuild the socket. We guard on authFailed so a token
    // edit during a healthy session doesn't yank the connection; such
    // a change still takes effect on the next manual reconnect (the
    // documented behaviour). Only act once statusBar exists (i.e. not
    // during the onload-time loadSettings call).
    const tokenChanged = this.settings.authToken !== this.lastAuthToken;
    this.lastAuthToken = this.settings.authToken;
    if (tokenChanged && this.authFailed && this.statusBar) {
      log.info("socket", "auth token changed while auth-failed — attempting recovery");
      void this.reconnect();
    }
  }

  private debug(...args: unknown[]): void {
    if (this.settings?.debugLogging) console.log(...args);
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

  // True when `this.socket` exists but its WebSocket will never recover
  // on its own — i.e. reconnection has been turned off (shouldConnect
  // === false, set by our disconnect() on auth failure, or by the
  // provider after maxAttempts) and it's sitting disconnected. FIX C:
  // such a socket is "dead" and connect() must rebuild it rather than
  // early-returning on its mere existence.
  private socketIsDead(): boolean {
    const s = this.socket as
      | (HocuspocusProviderWebsocket & {
          shouldConnect?: boolean;
          status?: string;
        })
      | null;
    if (!s) return false;
    return s.shouldConnect === false && s.status !== "connected";
  }

  private connect(): void {
    // FIX A — never auto-reconnect into a server that's rejecting our
    // token; that's exactly the storm we're killing. Recovery only
    // happens via the token-change path in saveSettings or the explicit
    // Reconnect command — both call clearAuthFailure() first.
    if (this.authFailed) {
      log.info("socket", "connect skipped: auth previously failed — fix the token, then reconnect");
      return;
    }
    // FIX C — connect() is idempotent and self-heals a dead socket.
    // A live (or still-retrying) socket → no-op. A dead socket
    // (shouldConnect=false, disconnected) → tear it down and rebuild,
    // instead of the old `if (this.socket) return` that stranded the
    // user offline forever after a terminal close.
    if (this.socket) {
      if (!this.socketIsDead()) return;
      log.info("socket", "connect: existing socket is dead — rebuilding");
      this.teardownSocket();
    }
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
      const sock = new HocuspocusProviderWebsocket({
        url: `${baseUrl}${sep}clientVersion=${encodeURIComponent(PLUGIN_VERSION)}`,
      });
      this.socket = sock;
      this.binaryClient = this.makeBinaryClient();
      this.socket.on("status", (event: { status: string }) => {
        log.info("socket", `status: ${event.status}`);
        this.connected = event.status === "connected";
        this.statusBar.setConnected(this.connected);
        // FIX C — when this socket goes to a disconnected state that it
        // won't climb out of on its own (reconnection disabled), null
        // it so the next connect()/autoconnect rebuilds a fresh one.
        // Compare identity: a status callback from a stale socket must
        // never clobber a socket we've already rebuilt.
        if (
          event.status === "disconnected" &&
          this.socket === sock &&
          this.socketIsDead()
        ) {
          log.info("socket", "status: terminal disconnect — clearing dead socket");
          this.teardownSocket();
        }
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

  // FIX A — the server rejected our auth handshake (surfaced by the
  // manifest provider's authenticationFailed event). Stop the websocket's
  // reconnect loop and put the plugin into a persistent, recoverable
  // "auth failed" state instead of letting the socket hammer the server
  // forever behind a one-shot Notice.
  private handleAuthFailure(reason: string): void {
    if (this.authFailed) return; // already handled this episode
    this.authFailed = true;
    log.error("socket", `auth failed — stopping reconnect loop: ${reason}`);
    // disconnect() sets shouldConnect=false and closes the WS, so the
    // provider's onClose does NOT schedule another connect — the storm
    // stops. We then null the socket so the recovery path rebuilds
    // cleanly (rather than reusing a socket whose shouldConnect we'd
    // have to flip back manually).
    try {
      this.socket?.disconnect();
    } catch (err) {
      log.warn("socket", "disconnect during auth-failure handling threw", err);
    }
    this.teardownSocket();
    this.connected = false;
    this.statusBar.setConnected(false);
    // Persistent indicator (not a disappearing toast). One Notice is
    // fine on top for immediacy, but the status bar carries the state.
    this.statusBar.setAuthFailed(true);
    new Notice(
      "Collab: server rejected the auth token. Sync is paused — update your Auth token in settings (or run “Reconnect to server”) to resume.",
      12_000,
    );
  }

  // Tear down the websocket object + its dependents WITHOUT touching the
  // authFailed flag. Used by connect() (dead-socket rebuild), the
  // auth-failure handler, and reconnect(). Does NOT destroyAll sessions
  // — callers that need that (reconnect) do it explicitly.
  private teardownSocket(): void {
    this.socket?.destroy();
    this.socket = null;
    this.binaryClient = null;
  }

  // FIX A recovery — clear the auth-failed state and attempt a fresh
  // connection. Invoked from the "Reconnect" command and from
  // saveSettings when the user edits the auth token.
  private clearAuthFailure(): void {
    if (!this.authFailed) return;
    log.info("socket", "clearing auth-failed state — will attempt a fresh connect");
    this.authFailed = false;
    this.statusBar.setAuthFailed(false);
  }

  private async reconnect(): Promise<void> {
    await this.manifestSync.stop();
    await this.sessionManager.destroyAll();
    this.teardownSocket();
    this.connected = false;
    this.statusBar.setConnected(false);
    // FIX A — an explicit Reconnect is the user's "I fixed the token"
    // signal. Clear the auth-failed gate so connect() actually rebuilds
    // the socket instead of refusing.
    this.clearAuthFailure();
    // v2.0.0: after destroyAll, every LiveView's resolveContext returns
    // null (no bound sessions). Queue a refresh so each LiveView
    // transitions to release()/inert immediately and yedit's
    // unobserve runs before connect() rebuilds the sessions. Without
    // this, leftover ytext observers from the destroyed sessions can
    // fire one more event before unobserve takes effect.
    this.liveViewManager?.queueRefresh("reconnect");
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
    this.teardownSocket();
    this.connected = false;
    this.statusBar.setConnected(false);
    this.liveViewManager?.queueRefresh("performWipeLocalCache");
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
