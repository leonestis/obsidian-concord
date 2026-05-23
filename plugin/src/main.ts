import {
  App,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
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

// ─────────────────────────────────────────────────────────────────────────────
// vault-structure sync (manifest)
// ─────────────────────────────────────────────────────────────────────────────
// Holds the full set of file paths in the vault. Every client observes it and
// mirrors local create/delete/rename into the manifest, and applies remote
// manifest changes back to its local vault. Per-file content sync (per-file
// Y.Doc) continues unchanged.

const MANIFEST_ROOM = "vault:manifest";

// Binary attachments above this size are skipped — Yjs is a poor transport
// for huge blobs, and a runaway 500 MB PDF would brick the manifest sync.
const MAX_BINARY_BYTES = 25 * 1024 * 1024; // 25 MB

type EntryKind = "file" | "folder" | "binary";

interface ManifestEntry {
  kind: EntryKind;
  createdAt: number;
}

// Obsidian's vault.create / createBinary / createFolder return a TFile|TFolder
// the moment the file appears. The accompanying 'create' event fires
// asynchronously — we use a Set of in-flight remote paths to suppress those
// echo events, then drop entries from the Set after a short delay.
const SUPPRESS_HOLD_MS = 1000;

// Yjs's Uint8Array values are sometimes backed by SharedArrayBuffer (depending
// on the runtime). Obsidian's binary file APIs need a plain ArrayBuffer, so we
// copy the bytes into a fresh buffer when crossing that boundary.
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

// Convert a vault-relative file path into a stable, safe Hocuspocus room name.
// We avoid raw slashes because some routing layers treat them specially.
function pathToRoom(path: string): string {
  return "file:" + path.replace(/\//g, "__");
}

// Per-editor compartment so we can swap the collab extension when the open file changes.
// y-codemirror.next's yCollab() does NOT accept cursorBuilder/selectionBuilder
// options — only `undoManager`. The default cursor widget renders a <span>
// containing a hidden `.cm-ySelectionInfo` div with the user's name, which the
// library's CSS only un-hides on hover. We patch the visibility via our own
// styles.css so the name is shown all the time.
const COLLAB_COMPARTMENT_KEY = "__collabCompartment__";
type CompartmentHolder = { compartment: Compartment; activeRoom: string | null };

// ─────────────────────────────────────────────────────────────────────────────
// plugin
// ─────────────────────────────────────────────────────────────────────────────

export default class CollabPlugin extends Plugin {
  settings!: CollabSettings;
  private socket: HocuspocusProviderWebsocket | null = null;
  private sessions = new Map<string, FileSession>();
  private statusEl: HTMLElement | null = null;
  private connected = false;

  // Vault manifest — single shared Y.Doc tracking which paths exist in the vault.
  // Holds two maps: `files` (path → {kind, createdAt}) for every file/folder,
  // and `binaryData` (path → Uint8Array) for the bytes of non-markdown files.
  private manifestYDoc: Y.Doc | null = null;
  private manifestMap: Y.Map<ManifestEntry> | null = null;
  private manifestBinaries: Y.Map<Uint8Array> | null = null;
  private manifestProvider: HocuspocusProvider | null = null;
  private manifestPersistence: IndexeddbPersistence | null = null;
  // Paths currently being applied from a remote manifest change. The local
  // vault event handlers skip these so we don't echo the change back into the
  // manifest (which would loop forever).
  private remoteApplyPaths = new Set<string>();

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

    this.addCommand({
      id: "collab-show-status",
      name: "Show connection status (diagnostics)",
      callback: () => this.showDiagnostics(),
    });

    // React to the user opening a file in any pane.
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => this.onFileOpen(file)),
    );

    // Vault structural events. Each fires both the per-file session handler
    // and the manifest handler — they're independent concerns: sessions
    // manage per-file Y.Docs, manifest broadcasts existence to all clients.
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.onRename(file, oldPath);
        this.onLocalVaultRename(file, oldPath);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.onDelete(file);
        this.onLocalVaultDelete(file);
      }),
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => this.onLocalVaultCreate(file)),
    );
    // Binary modify: re-upload bytes so peers get the new version.
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.onLocalVaultModify(file)),
    );

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.autoConnect) this.connect();
    });
  }

  async onunload() {
    console.log("[collab] unloading…");
    this.stopVaultSync();
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
    // Push the latest display name / color into every active session so
    // remote peers see the change immediately — without this, the new name
    // only landed when a session was first created.
    for (const session of this.sessions.values()) {
      session.provider.awareness?.setLocalStateField("user", {
        name: this.settings.userName,
        color: this.settings.userColor,
      });
    }
    this.renderStatus();
  }

  private showDiagnostics() {
    const lines: string[] = [];
    lines.push(`Server URL: ${this.settings.serverUrl}`);
    lines.push(`Socket: ${this.socket ? (this.connected ? "🟢 connected" : "🟡 not connected") : "🔴 no socket"}`);
    lines.push(`Active sessions: ${this.sessions.size}`);
    for (const s of this.sessions.values()) {
      const wsStatus = (s.provider as unknown as { status: string }).status ?? "?";
      const peers = s.provider.awareness ? s.provider.awareness.getStates().size : 0;
      lines.push(`  • ${s.filePath}  →  status=${wsStatus}, peers=${peers}, length=${s.ytext.length}`);
    }
    const msg = lines.join("\n");
    console.log("[collab] diagnostics:\n" + msg);
    new Notice(msg, 12_000);
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
        console.log(`[collab] socket status: ${event.status}`);
        const wasConnected = this.connected;
        this.connected = event.status === "connected";
        if (this.connected !== wasConnected) this.renderStatus();
      });
      this.socket.on("close", (event: unknown) => {
        console.log("[collab] socket close", event);
      });
      // Spin up the vault-structure sync (single shared manifest Y.Doc).
      this.startVaultSync();
      // Bind any already-open markdown file.
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile && activeFile.extension === "md") this.attachFile(activeFile);
    } catch (err) {
      console.error("[collab] failed to open socket", err);
      new Notice("Collab: failed to connect — see console");
    }
  }

  private reconnect() {
    this.stopVaultSync();
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
    const targetRoom = pathToRoom(file.path);
    const collabExtension = yCollab(session.ytext, session.provider.awareness);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const viewAny = editorView as any;
    let holder = viewAny[COLLAB_COMPARTMENT_KEY] as CompartmentHolder | undefined;

    if (!holder) {
      // First-time setup for this editor: install the compartment with the
      // collab extension already inside, in a single dispatch. Doing init and
      // reconfigure as two separate transactions left a window where the new
      // compartment existed but didn't hold yCollab yet, which scrambled the
      // sync state on plugin reload.
      const compartment = new Compartment();
      holder = { compartment, activeRoom: targetRoom };
      viewAny[COLLAB_COMPARTMENT_KEY] = holder;
      editorView.dispatch({
        effects: StateEffect.appendConfig.of(compartment.of(collabExtension)),
      });
      return;
    }

    if (holder.activeRoom === targetRoom) return; // already bound to this room
    holder.activeRoom = targetRoom;
    editorView.dispatch({
      effects: holder.compartment.reconfigure(collabExtension),
    });
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

    // CRITICAL: when a HocuspocusProvider is constructed with a shared
    // websocketProvider, it does NOT register itself with that socket
    // automatically (manageSocket is false). Without calling attach() the
    // provider gets created but never receives sync or awareness messages —
    // i.e. no sync, and remote cursors look "Anonymous" because their user
    // field never reaches us.
    provider.attach();

    provider.on("status", (event: { status: string }) => {
      console.log(`[collab] room "${room}" status: ${event.status}`);
    });
    provider.on("synced", () => {
      console.log(`[collab] room "${room}" synced`);
    });
    provider.on("authenticationFailed", (data: { reason: string }) => {
      console.error(`[collab] room "${room}" auth failed: ${data.reason}`);
      new Notice(`Collab: authentication rejected for ${file.path}`);
    });

    provider.awareness?.setLocalStateField("user", {
      name: this.settings.userName,
      color: this.settings.userColor,
    });

    // Local persistence: edits made offline are queued in the browser's
    // IndexedDB and replayed to the server on reconnect. Key includes the
    // server URL so switching servers doesn't muddle different vaults.
    const persistenceKey = `obsidian-collab::${this.settings.serverUrl}::${room}`;
    const persistence = new IndexeddbPersistence(persistenceKey, ydoc);
    persistence.on("synced", () => {
      console.log(`[collab] local cache loaded for ${room}`);
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

  // ── vault structure sync (manifest) ────────────────────────────────────────

  private startVaultSync() {
    if (!this.socket || this.manifestProvider) return;

    this.manifestYDoc = new Y.Doc();
    this.manifestMap = this.manifestYDoc.getMap<ManifestEntry>("files");
    this.manifestBinaries = this.manifestYDoc.getMap<Uint8Array>("binaryData");

    this.manifestProvider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: MANIFEST_ROOM,
      document: this.manifestYDoc,
      token: this.settings.authToken || undefined,
    });
    this.manifestProvider.attach();

    this.manifestPersistence = new IndexeddbPersistence(
      `obsidian-collab::${this.settings.serverUrl}::${MANIFEST_ROOM}`,
      this.manifestYDoc,
    );

    this.manifestProvider.on("synced", () => {
      console.log(`[collab] manifest synced (${this.manifestMap?.size ?? 0} entries)`);
      void this.reconcileManifest();
    });

    this.manifestMap.observe((event) => this.onManifestChange(event));
    // When the bytes of an existing binary are updated, write to local disk.
    this.manifestBinaries.observe((event) => this.onBinaryDataChange(event));
  }

  private stopVaultSync() {
    this.manifestProvider?.destroy();
    this.manifestProvider = null;
    void this.manifestPersistence?.destroy();
    this.manifestPersistence = null;
    this.manifestYDoc?.destroy();
    this.manifestYDoc = null;
    this.manifestMap = null;
    this.manifestBinaries = null;
    this.remoteApplyPaths.clear();
  }

  // First sync after connect: union the manifest with the local vault.
  // - Entries in manifest but missing locally → create them (markdown empty
  //   so per-file Y.Doc fills it; folders made on the spot; binaries written
  //   from the bytes stored in the manifest).
  // - Local files/folders missing from manifest → register them.
  private async reconcileManifest() {
    if (!this.manifestMap || !this.manifestBinaries || !this.manifestYDoc) return;

    const localPaths = new Set<string>();
    const allLocal: TAbstractFile[] = [];
    this.walkVault(this.app.vault.getRoot(), allLocal);
    for (const f of allLocal) localPaths.add(f.path);

    // Manifest → local
    for (const [path, entry] of this.manifestMap.entries()) {
      if (localPaths.has(path)) continue;
      await this.materialise(path, entry);
    }

    // Local → manifest (for anything not yet registered)
    this.manifestYDoc.transact(() => {
      for (const file of allLocal) {
        if (this.manifestMap!.has(file.path)) continue;
        const kind = this.classify(file);
        if (!kind) continue;
        this.manifestMap!.set(file.path, { kind, createdAt: Date.now() });
        if (kind === "binary" && file instanceof TFile) {
          // Schedule binary upload outside the transact (async read).
          void this.uploadBinary(file);
        }
      }
    });
  }

  // Recursively collect every file and folder in the vault.
  private walkVault(folder: TFolder, out: TAbstractFile[]) {
    for (const child of folder.children) {
      out.push(child);
      if (child instanceof TFolder) this.walkVault(child, out);
    }
  }

  // Decide which manifest kind a vault entry maps to. Root folder is skipped
  // (no path), and we ignore Obsidian's `.obsidian/` config directory.
  private classify(file: TAbstractFile): EntryKind | null {
    if (!file.path || file.path.startsWith(".obsidian/") || file.path === ".obsidian") return null;
    if (file instanceof TFolder) return "folder";
    if (file instanceof TFile) return file.extension === "md" ? "file" : "binary";
    return null;
  }

  // Create a local entry from a manifest record.
  private async materialise(path: string, entry: ManifestEntry) {
    this.remoteApplyPaths.add(path);
    try {
      if (entry.kind === "folder") {
        if (!this.app.vault.getAbstractFileByPath(path)) {
          await this.app.vault.createFolder(path);
          console.log(`[collab] reconcile: created folder ${path}`);
        }
        return;
      }
      await this.ensureFolderExists(path);
      if (entry.kind === "file") {
        if (!this.app.vault.getAbstractFileByPath(path)) {
          await this.app.vault.create(path, "");
          console.log(`[collab] reconcile: created file ${path}`);
        }
        return;
      }
      // binary
      const bytes = this.manifestBinaries?.get(path);
      if (!bytes) {
        // Either not uploaded yet or peer is offline. Skip — we'll catch the
        // bytes via the binaryData observer once they arrive.
        console.log(`[collab] reconcile: binary ${path} has no data yet — waiting`);
        return;
      }
      if (!this.app.vault.getAbstractFileByPath(path)) {
        await this.app.vault.createBinary(path, toArrayBuffer(bytes));
        console.log(`[collab] reconcile: created binary ${path} (${bytes.byteLength} bytes)`);
      }
    } catch (err) {
      console.warn("[collab] materialise failed", path, err);
    } finally {
      setTimeout(() => this.remoteApplyPaths.delete(path), SUPPRESS_HOLD_MS);
    }
  }

  private async uploadBinary(file: TFile) {
    if (!this.manifestBinaries) return;
    try {
      const buf = await this.app.vault.readBinary(file);
      if (buf.byteLength > MAX_BINARY_BYTES) {
        console.warn(`[collab] skipping ${file.path}: ${buf.byteLength} bytes exceeds ${MAX_BINARY_BYTES}`);
        new Notice(`Collab: ${file.path} is too large to sync (>${Math.floor(MAX_BINARY_BYTES / 1024 / 1024)} MB)`);
        return;
      }
      this.manifestBinaries.set(file.path, new Uint8Array(buf));
      console.log(`[collab] uploaded binary ${file.path} (${buf.byteLength} bytes)`);
    } catch (err) {
      console.warn("[collab] uploadBinary failed", file.path, err);
    }
  }

  private async ensureFolderExists(filePath: string) {
    const slash = filePath.lastIndexOf("/");
    if (slash <= 0) return;
    const folder = filePath.substring(0, slash);
    if (this.app.vault.getAbstractFileByPath(folder)) return;
    try {
      await this.app.vault.createFolder(folder);
    } catch (err) {
      // createFolder throws if already exists — race with another sibling create.
      if (!/already exists/i.test(String(err))) throw err;
    }
  }

  // ── local → manifest ───────────────────────────────────────────────────────

  private onLocalVaultCreate(file: TAbstractFile) {
    if (!this.manifestMap) return;
    if (this.remoteApplyPaths.has(file.path)) return;
    const kind = this.classify(file);
    if (!kind) return;
    if (this.manifestMap.has(file.path)) return;
    this.manifestMap.set(file.path, { kind, createdAt: Date.now() });
    if (kind === "binary" && file instanceof TFile) void this.uploadBinary(file);
  }

  private onLocalVaultDelete(file: TAbstractFile) {
    if (!this.manifestMap || !this.manifestBinaries || !this.manifestYDoc) return;
    if (this.remoteApplyPaths.has(file.path)) return;
    if (!this.manifestMap.has(file.path)) return;
    this.manifestYDoc.transact(() => {
      this.manifestMap!.delete(file.path);
      if (this.manifestBinaries!.has(file.path)) this.manifestBinaries!.delete(file.path);
    });
  }

  private onLocalVaultRename(file: TAbstractFile, oldPath: string) {
    if (!this.manifestMap || !this.manifestBinaries || !this.manifestYDoc) return;
    if (this.remoteApplyPaths.has(file.path) || this.remoteApplyPaths.has(oldPath)) return;
    const kind = this.classify(file);
    if (!kind) return;
    // Group delete + set in one transaction so peers can recognise this as
    // a rename (1 delete + 1 add in the same change event) instead of a
    // delete-then-create, which would lose content.
    this.manifestYDoc.transact(() => {
      this.manifestMap!.delete(oldPath);
      this.manifestMap!.set(file.path, { kind, createdAt: Date.now() });
      const data = this.manifestBinaries!.get(oldPath);
      if (data) {
        this.manifestBinaries!.delete(oldPath);
        this.manifestBinaries!.set(file.path, data);
      }
    });
  }

  private onLocalVaultModify(file: TAbstractFile) {
    if (!(file instanceof TFile)) return;
    if (file.extension === "md") return; // markdown content syncs via per-file Y.Doc
    if (!this.manifestMap || !this.manifestBinaries) return;
    if (this.remoteApplyPaths.has(file.path)) return;
    if (!this.manifestMap.has(file.path)) {
      // First time we see it. Register and upload.
      this.manifestMap.set(file.path, { kind: "binary", createdAt: Date.now() });
    }
    void this.uploadBinary(file);
  }

  // ── manifest → local ───────────────────────────────────────────────────────

  private async onManifestChange(event: Y.YMapEvent<ManifestEntry>) {
    const deletes: string[] = [];
    const adds: Array<{ path: string; entry: ManifestEntry }> = [];
    event.changes.keys.forEach((change, key) => {
      if (change.action === "delete") deletes.push(key);
      else if (change.action === "add") {
        const entry = this.manifestMap?.get(key);
        if (entry) adds.push({ path: key, entry });
      }
    });

    // Single delete + single add in one transaction is treated as a rename:
    // we move the local file, preserving its contents.
    if (deletes.length === 1 && adds.length === 1) {
      await this.applyRemoteRename(deletes[0], adds[0].path, adds[0].entry);
      return;
    }

    for (const path of deletes) await this.applyRemoteDelete(path);
    for (const a of adds) await this.materialise(a.path, a.entry);
  }

  // When the manifestBinaries map changes — typically because a peer
  // re-uploaded an existing image — write the new bytes to local disk.
  private async onBinaryDataChange(event: Y.YMapEvent<Uint8Array>) {
    if (!this.manifestBinaries) return;
    for (const [path, change] of event.changes.keys.entries()) {
      if (change.action === "delete") continue; // delete is handled via manifestMap
      const bytes = this.manifestBinaries.get(path);
      if (!bytes) continue;
      const local = this.app.vault.getAbstractFileByPath(path);
      this.remoteApplyPaths.add(path);
      try {
        if (local instanceof TFile) {
          await this.app.vault.modifyBinary(local, toArrayBuffer(bytes));
          console.log(`[collab] remote binary update: ${path} (${bytes.byteLength} bytes)`);
        } else if (!local) {
          await this.ensureFolderExists(path);
          await this.app.vault.createBinary(path, toArrayBuffer(bytes));
          console.log(`[collab] remote binary create: ${path} (${bytes.byteLength} bytes)`);
        }
      } catch (err) {
        console.warn("[collab] remote binary write failed", path, err);
      } finally {
        setTimeout(() => this.remoteApplyPaths.delete(path), SUPPRESS_HOLD_MS);
      }
    }
  }

  private async applyRemoteRename(oldPath: string, newPath: string, entry: ManifestEntry) {
    const localFile = this.app.vault.getAbstractFileByPath(oldPath);
    if (!localFile) {
      await this.materialise(newPath, entry);
      return;
    }
    this.remoteApplyPaths.add(oldPath);
    this.remoteApplyPaths.add(newPath);
    try {
      await this.ensureFolderExists(newPath);
      await this.app.fileManager.renameFile(localFile, newPath);
      console.log(`[collab] remote rename: ${oldPath} → ${newPath}`);
    } catch (err) {
      console.warn("[collab] remote rename failed", oldPath, newPath, err);
    } finally {
      setTimeout(() => {
        this.remoteApplyPaths.delete(oldPath);
        this.remoteApplyPaths.delete(newPath);
      }, SUPPRESS_HOLD_MS);
    }
  }

  private async applyRemoteDelete(path: string) {
    const localFile = this.app.vault.getAbstractFileByPath(path);
    if (!localFile) return;
    this.remoteApplyPaths.add(path);
    try {
      await this.app.vault.delete(localFile, true);
      console.log(`[collab] remote delete: ${path}`);
    } catch (err) {
      console.warn("[collab] remote delete failed", path, err);
    } finally {
      setTimeout(() => this.remoteApplyPaths.delete(path), SUPPRESS_HOLD_MS);
    }
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
      .setDesc("Picked color for your caret + name label.")
      .addColorPicker((picker) =>
        picker.setValue(this.plugin.settings.userColor).onChange(async (value) => {
          this.plugin.settings.userColor = value;
          await this.plugin.saveSettings();
        }),
      )
      .addExtraButton((btn) =>
        btn
          .setIcon("reset")
          .setTooltip("Reset color to auto-pick from display name")
          .onClick(async () => {
            this.plugin.settings.userColor = colorFromName(this.plugin.settings.userName);
            await this.plugin.saveSettings();
            this.display(); // re-render so the picker shows the new value
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
