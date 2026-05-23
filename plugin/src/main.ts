import {
  App,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
} from "obsidian";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { removeAwarenessStates } from "y-protocols/awareness";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";

// ─────────────────────────────────────────────────────────────────────────────
// settings
// ─────────────────────────────────────────────────────────────────────────────

interface CollabSettings {
  serverUrl: string;
  authToken: string;
  userName: string;
  userColor: string;
  autoConnect: boolean;
}

const DEFAULT_SETTINGS: CollabSettings = {
  serverUrl: "ws://158.255.5.243:1234",
  authToken: "",
  userName: "",
  userColor: "",
  autoConnect: true,
};

// Pleasant palette for auto-assigning a color when the user hasn't picked one.
const PALETTE = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#3b82f6", "#6366f1", "#a855f7", "#ec4899",
];

function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

function randomName(): string {
  return `user-${Math.floor(Math.random() * 9000 + 1000)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// per-file session
// ─────────────────────────────────────────────────────────────────────────────

interface FileSession {
  filePath: string;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  ytext: Y.Text;
  persistence: IndexeddbPersistence;
}

// Convert a vault-relative file path into a stable, safe Hocuspocus room name.
// We avoid raw slashes because some routing layers treat them specially.
function pathToRoom(path: string): string {
  return "file:" + path.replace(/\//g, "__");
}

// Per-editor compartment so we can swap the collab extension when the open file changes.
const COLLAB_COMPARTMENT_KEY = "__collabCompartment__";
type CompartmentHolder = { compartment: Compartment; activeRoom: string | null };

function getCompartmentHolder(view: EditorView): CompartmentHolder {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const any = view as any;
  if (!any[COLLAB_COMPARTMENT_KEY]) {
    const compartment = new Compartment();
    any[COLLAB_COMPARTMENT_KEY] = { compartment, activeRoom: null } as CompartmentHolder;
    // Install the compartment into the running editor with an empty extension —
    // we'll reconfigure it later when we know which room this view should join.
    view.dispatch({ effects: StateEffect.appendConfig.of(compartment.of([])) });
  }
  return any[COLLAB_COMPARTMENT_KEY];
}

// ─────────────────────────────────────────────────────────────────────────────
// custom cursor renderer — always-visible name label above the bar
// ─────────────────────────────────────────────────────────────────────────────

interface AwarenessUser {
  name?: string;
  color?: string;
}

function buildCursor(user: AwarenessUser | undefined): HTMLElement {
  const name = user?.name || "anonymous";
  const color = user?.color || "#888";

  const cursor = document.createElement("span");
  cursor.classList.add("collab-cursor");
  cursor.style.setProperty("--collab-color", color);

  const label = document.createElement("span");
  label.classList.add("collab-cursor-label");
  label.textContent = name;
  cursor.appendChild(label);

  return cursor;
}

function buildSelection(user: AwarenessUser | undefined): { class: string; style: string } {
  const color = user?.color || "#888";
  return {
    class: "collab-selection",
    style: `background-color: ${hexToRgba(color, 0.25)};`,
  };
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(136,136,136,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// plugin
// ─────────────────────────────────────────────────────────────────────────────

export default class CollabPlugin extends Plugin {
  settings!: CollabSettings;
  private socket: HocuspocusProviderWebsocket | null = null;
  private sessions = new Map<string, FileSession>();
  private statusEl: HTMLElement | null = null;
  private connected = false;

  async onload() {
    await this.loadSettings();
    console.log("[collab] plugin loaded");

    this.addSettingTab(new CollabSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.renderStatus();

    this.addCommand({
      id: "collab-reconnect",
      name: "Reconnect to server",
      callback: () => this.reconnect(),
    });

    // React to the user opening a file in any pane.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => this.onFileOpen(file)),
    );

    // Rename: shift the room name for any open session.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)),
    );

    // Delete: tear down the session so the bar doesn't show a stale entry.
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.onDelete(file)),
    );

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoConnect) this.connect();
    });
  }

  async onunload() {
    console.log("[collab] unloading…");
    for (const session of this.sessions.values()) this.destroySession(session);
    this.sessions.clear();
    this.socket?.destroy();
    this.socket = null;
    console.log("[collab] unloaded");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.userName) this.settings.userName = randomName();
    if (!this.settings.userColor) this.settings.userColor = colorFromName(this.settings.userName);
    await this.saveSettings();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ── connection ─────────────────────────────────────────────────────────────

  private connect() {
    if (this.socket) return;
    try {
      this.socket = new HocuspocusProviderWebsocket({
        url: this.settings.serverUrl,
        // y-websocket-style auto-reconnect with exponential backoff is on by default;
        // we just don't have to disable it.
      });
      // HocuspocusProviderWebsocket emits a single `status` event with payload
      // `{ status: 'connecting' | 'connected' | 'disconnected' }`. Don't listen
      // for "connect"/"disconnect" — those don't exist and silently no-op,
      // which is why the status bar appeared stuck on "offline" earlier.
      this.socket.on("status", (event: { status: string }) => {
        const wasConnected = this.connected;
        this.connected = event.status === "connected";
        if (this.connected !== wasConnected) this.renderStatus();
      });
      // Bind any already-open markdown file.
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile && activeFile.extension === "md") this.attachFile(activeFile);
    } catch (err) {
      console.error("[collab] failed to open socket", err);
      new Notice("Collab: failed to connect — see console");
    }
  }

  private reconnect() {
    for (const session of this.sessions.values()) this.destroySession(session);
    this.sessions.clear();
    this.socket?.destroy();
    this.socket = null;
    this.connect();
    new Notice("Collab: reconnected");
  }

  // ── file lifecycle ─────────────────────────────────────────────────────────

  private onFileOpen(file: TFile | null) {
    if (!file || file.extension !== "md") return;
    if (!this.socket) return;
    this.attachFile(file);
  }

  private async attachFile(file: TFile) {
    if (!this.socket) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== file.path) return;

    let session = this.sessions.get(file.path);
    if (!session) session = await this.createSession(file);

    const editorView = (view.editor as unknown as { cm: EditorView }).cm;
    const holder = getCompartmentHolder(editorView);
    const targetRoom = pathToRoom(file.path);

    if (holder.activeRoom === targetRoom) return; // already bound to this room

    // y-codemirror.next accepts cursorBuilder/selectionBuilder at runtime but
    // its TS types don't declare them on the public options interface, so cast.
    const collabExtension = yCollab(session.ytext, session.provider.awareness, {
      cursorBuilder: buildCursor,
      selectionBuilder: buildSelection,
    } as unknown as Parameters<typeof yCollab>[2]);

    editorView.dispatch({
      effects: holder.compartment.reconfigure(collabExtension),
    });
    holder.activeRoom = targetRoom;
  }

  private async createSession(file: TFile): Promise<FileSession> {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    const room = pathToRoom(file.path);

    const provider = new HocuspocusProvider({
      websocketProvider: this.socket!,
      name: room,
      document: ydoc,
      token: this.settings.authToken || undefined,
    });

    // Local persistence: edits made offline are queued in the browser's
    // IndexedDB and replayed to the server on reconnect. Key includes the
    // server URL so switching servers doesn't muddle different vaults.
    const persistenceKey = `obsidian-collab::${this.settings.serverUrl}::${room}`;
    const persistence = new IndexeddbPersistence(persistenceKey, ydoc);
    persistence.on("synced", () => {
      console.log(`[collab] local cache loaded for ${room}`);
    });

    provider.awareness?.setLocalStateField("user", {
      name: this.settings.userName,
      color: this.settings.userColor,
    });

    provider.on("synced", async () => {
      // First client into the room seeds the document with disk content.
      if (ytext.length === 0) {
        try {
          const content = await this.app.vault.read(file);
          if (content.length > 0) ytext.insert(0, content);
        } catch (err) {
          console.warn("[collab] seed read failed for", file.path, err);
        }
      }
    });

    const session: FileSession = { filePath: file.path, ydoc, provider, ytext, persistence };
    this.sessions.set(file.path, session);
    return session;
  }

  private destroySession(session: FileSession) {
    void session.persistence.destroy();
    try {
      // Tell peers we're gone — prevents lingering ghost cursors.
      if (session.provider.awareness) {
        session.provider.awareness.setLocalState(null);
        removeAwarenessStates(
          session.provider.awareness,
          [session.provider.awareness.clientID],
          "destroy",
        );
      }
    } catch (err) {
      console.warn("[collab] awareness clear failed", err);
    }
    session.provider.destroy();
    session.ydoc.destroy();
  }

  private onRename(file: TAbstractFile, oldPath: string) {
    const session = this.sessions.get(oldPath);
    if (!session) return;
    this.destroySession(session);
    this.sessions.delete(oldPath);
    if (file instanceof TFile && file.extension === "md") void this.attachFile(file);
  }

  private onDelete(file: TAbstractFile) {
    const session = this.sessions.get(file.path);
    if (!session) return;
    this.destroySession(session);
    this.sessions.delete(file.path);
  }

  // ── status bar ─────────────────────────────────────────────────────────────

  private renderStatus() {
    if (!this.statusEl) return;
    const dot = this.connected ? "🟢" : "🔴";
    const label = this.connected ? "collab live" : "collab offline";
    this.statusEl.setText(`${dot} ${label}`);
    this.statusEl.setAttr("title", `Server: ${this.settings.serverUrl}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// settings tab
// ─────────────────────────────────────────────────────────────────────────────

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
          .setPlaceholder("ws://158.255.5.243:1234")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auth token")
      .setDesc("JWT token issued by the server admin. Leave empty if the server does not require auth.")
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
      .setDesc("Hex like #3b82f6. Empty = auto-pick from name.")
      .addText((text) =>
        text
          .setPlaceholder("#3b82f6")
          .setValue(this.plugin.settings.userColor)
          .onChange(async (value) => {
            const v = value.trim();
            this.plugin.settings.userColor = v || colorFromName(this.plugin.settings.userName);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-connect on startup")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoConnect).onChange(async (value) => {
          this.plugin.settings.autoConnect = value;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Use the command palette → \"Collab: Reconnect to server\" to apply changes.",
    });
  }
}
