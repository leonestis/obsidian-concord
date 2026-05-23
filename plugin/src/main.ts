import {
  App,
  MarkdownView,
  Modal,
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

// Sessions for non-markdown files that we want fully collaborative. Two
// shapes: structural (Canvas — Y.Map per node) and atomic (single Y.Map
// holding the whole file as a string). Both guarantee that whatever we
// write to disk parses cleanly — a structural canvas merges concurrent
// edits to different nodes; an atomic file resolves to whoever saved last.
interface CanvasSession {
  kind: "canvas";
  filePath: string;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  persistence: IndexeddbPersistence;
  nodes: Y.Map<Y.Map<unknown>>;
  edges: Y.Map<Y.Map<unknown>>;
  meta: Y.Map<unknown>;
  lastSerialized: string;
  // Reference so we can stop observing on destroy.
  deepObserver: () => void;
}

interface AtomicTextSession {
  kind: "atomic";
  filePath: string;
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  persistence: IndexeddbPersistence;
  // Single-cell Y.Map: { content: string }. Updates replace the whole
  // string, so the file on disk is never half-parsed.
  doc: Y.Map<string>;
  lastSynced: string;
  observer: () => void;
}

type StructuralSession = CanvasSession | AtomicTextSession;

// Obsidian Canvas 1.0 JSON shape. We only care about nodes, edges, and any
// other top-level keys we mirror through `meta`. Field shapes inside nodes
// and edges are kept loose because the spec is extended frequently and we
// only round-trip without interpreting them.
interface CanvasJson {
  nodes: Array<Record<string, unknown> & { id?: string }>;
  edges: Array<Record<string, unknown> & { id?: string }>;
  [key: string]: unknown;
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

// "file"    = markdown (.md), per-file Y.Text with editor binding
// "canvas"  = Obsidian Canvas (.canvas). JSON synced structurally via Y.Map<id,Y.Map>
//             over nodes / edges / meta — concurrent edits never produce broken JSON.
// "text"    = atomic-replace text file (.base today, more later if useful).
//             Single Y.Map "doc"."content" string. Last writer wins per save,
//             never produces broken state because each write is one full file.
// "binary"  = everything else (images, PDFs, audio …) — bytes in manifestBinaries
// "folder"  = empty folder marker
type EntryKind = "file" | "folder" | "binary" | "canvas" | "text";

const CANVAS_EXTENSIONS = new Set(["canvas"]);
const ATOMIC_TEXT_EXTENSIONS = new Set(["base"]);

interface ManifestEntry {
  kind: EntryKind;
  createdAt: number;
}

// Soft-deleted entries live in manifestTrash for this long before any client
// permanently purges them on connect. 30 days mirrors most cloud trash bins.
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface TrashEntry {
  uuid: string;
  originalPath: string;
  kind: EntryKind;
  deletedAt: number;
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

// Wait until a HocuspocusProvider has completed its first sync with the
// server (or until `timeoutMs` elapses). Resolves immediately if the
// provider already reports synced. Used so we never bind yCollab to an
// editor while the Y.Text is still empty pending its first server reply —
// that would clear the editor and Obsidian would auto-save the empty
// buffer, wiping the file on disk.
function waitForProviderSync(provider: HocuspocusProvider, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((provider as any).synced === true) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (provider as any).off?.("synced", finish);
      resolve();
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (provider as any).on("synced", finish);
    setTimeout(finish, timeoutMs);
  });
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
  // Holds three maps:
  //   files       — path → {kind, createdAt}     for every file / folder
  //   binaryData  — path → Uint8Array            bytes for binary files
  //   trash       — uuid → {originalPath, …}     soft-deleted entries (30d retention)
  // Per-file content for markdown and text files lives in their own Y.Docs.
  private manifestYDoc: Y.Doc | null = null;
  private manifestMap: Y.Map<ManifestEntry> | null = null;
  private manifestBinaries: Y.Map<Uint8Array> | null = null;
  private manifestTrash: Y.Map<TrashEntry> | null = null;
  private manifestProvider: HocuspocusProvider | null = null;
  private manifestPersistence: IndexeddbPersistence | null = null;
  // Per-file structural sessions for non-markdown content we want fully
  // synced. Canvas uses the structural variant; .base uses the atomic
  // whole-file variant. Both keyed by vault-relative file path.
  private structuralSessions = new Map<string, StructuralSession>();
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

    this.addCommand({
      id: "collab-show-trash",
      name: "Show deleted files (trash)",
      callback: () => this.openTrashModal(),
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
    const isNewSession = !session;
    if (!session) session = await this.createSession(file);

    // CRITICAL: do NOT bind yCollab to the editor while Y.Text is still
    // empty — yCollab would replace the editor's content with the empty
    // Y.Text and Obsidian would auto-save the cleared buffer to disk,
    // wiping the file. So for a fresh session: first await the local
    // IndexedDB cache OR the first server sync, then seed Y.Text from
    // disk if neither produced any content. Only after that bind yCollab.
    if (isNewSession) {
      try {
        await Promise.race([
          Promise.all([
            session.persistence.whenSynced,
            waitForProviderSync(session.provider, 4000),
          ]),
          new Promise<void>((resolve) => setTimeout(resolve, 4000)),
        ]);
      } catch (err) {
        console.warn("[collab] sync-before-bind raced an error", file.path, err);
      }
      if (session.ytext.length === 0) {
        try {
          const diskContent = await this.app.vault.read(file);
          if (diskContent.length > 0) {
            session.ytext.insert(0, diskContent);
            console.log(`[collab] seeded "${file.path}" from disk (${diskContent.length} chars)`);
          }
        } catch (err) {
          console.warn("[collab] disk-seed failed", file.path, err);
        }
      }
      // The active view may have moved on while we were awaiting — re-check
      // and bail rather than yank the user's editor.
      const stillActive = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!stillActive || stillActive.file?.path !== file.path) return;
    }

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

    // (Seeding from disk now lives in attachFile, which awaits cache + server
    // sync before deciding whether the Y.Text is genuinely empty — so we
    // don't accidentally double-seed and concatenate two copies of the file.)

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
    this.manifestTrash = this.manifestYDoc.getMap<TrashEntry>("trash");

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
    for (const path of Array.from(this.structuralSessions.keys())) this.closeStructuralSession(path);
    this.manifestProvider?.destroy();
    this.manifestProvider = null;
    void this.manifestPersistence?.destroy();
    this.manifestPersistence = null;
    this.manifestYDoc?.destroy();
    this.manifestYDoc = null;
    this.manifestMap = null;
    this.manifestBinaries = null;
    this.manifestTrash = null;
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
    const newBinaries: TFile[] = [];
    const newStructural: Array<{ file: TFile; kind: "canvas" | "text" }> = [];
    this.manifestYDoc.transact(() => {
      for (const file of allLocal) {
        if (this.manifestMap!.has(file.path)) continue;
        const kind = this.classify(file);
        if (!kind) continue;
        this.manifestMap!.set(file.path, { kind, createdAt: Date.now() });
        if (kind === "binary" && file instanceof TFile) newBinaries.push(file);
        if ((kind === "canvas" || kind === "text") && file instanceof TFile) {
          newStructural.push({ file, kind });
        }
      }
    });
    for (const f of newBinaries) void this.uploadBinary(f);
    for (const s of newStructural) this.openStructuralSession(s.file.path, s.kind);

    // Also open structural sessions for canvas/atomic entries already in
    // the manifest that map to a local file — they need a live Y.Doc.
    for (const [path, entry] of this.manifestMap.entries()) {
      if (entry.kind !== "canvas" && entry.kind !== "text") continue;
      const local = this.app.vault.getAbstractFileByPath(path);
      if (local instanceof TFile && !this.structuralSessions.has(path)) {
        this.openStructuralSession(path, entry.kind);
      }
    }

    // Purge trash entries older than the retention window.
    this.purgeOldTrash();

    console.log(
      `[collab] reconcile complete: manifest has ${this.manifestMap.size} entries, trash ${this.manifestTrash?.size ?? 0}`,
    );
  }

  private purgeOldTrash() {
    if (!this.manifestTrash || !this.manifestBinaries || !this.manifestYDoc) return;
    const now = Date.now();
    const toDrop: string[] = [];
    for (const [uuid, entry] of this.manifestTrash.entries()) {
      if (now - entry.deletedAt > TRASH_RETENTION_MS) toDrop.push(uuid);
    }
    if (toDrop.length === 0) return;
    this.manifestYDoc.transact(() => {
      for (const uuid of toDrop) {
        this.manifestTrash!.delete(uuid);
        this.manifestBinaries!.delete(`trash:${uuid}`);
      }
    });
    console.log(`[collab] purged ${toDrop.length} expired trash entries`);
  }

  // Restore: move a trash entry back into the live manifest.
  private async restoreFromTrash(uuid: string) {
    if (!this.manifestTrash || !this.manifestMap || !this.manifestBinaries || !this.manifestYDoc) return;
    const entry = this.manifestTrash.get(uuid);
    if (!entry) return;
    let destPath = entry.originalPath;
    // If a file already lives at the original path, append " (restored)" to
    // the basename so we don't clobber it.
    if (this.manifestMap.has(destPath)) {
      const dot = destPath.lastIndexOf(".");
      const base = dot > 0 ? destPath.slice(0, dot) : destPath;
      const ext = dot > 0 ? destPath.slice(dot) : "";
      destPath = `${base} (restored)${ext}`;
    }
    this.manifestYDoc.transact(() => {
      this.manifestTrash!.delete(uuid);
      this.manifestMap!.set(destPath, { kind: entry.kind, createdAt: Date.now() });
      const bytes = this.manifestBinaries!.get(`trash:${uuid}`);
      if (bytes) {
        this.manifestBinaries!.delete(`trash:${uuid}`);
        this.manifestBinaries!.set(destPath, bytes);
      }
    });
    new Notice(`Restored ${destPath}`);
    console.log(`[collab] restored ${entry.originalPath} → ${destPath}`);
  }

  private openTrashModal() {
    if (!this.manifestTrash) {
      new Notice("Collab: not connected — open trash after socket connects");
      return;
    }
    new TrashModal(this.app, this.manifestTrash, (uuid) => this.restoreFromTrash(uuid)).open();
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
    if (file instanceof TFile) {
      if (file.extension === "md") return "file";
      if (CANVAS_EXTENSIONS.has(file.extension)) return "canvas";
      if (ATOMIC_TEXT_EXTENSIONS.has(file.extension)) return "text";
      return "binary";
    }
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
      if (entry.kind === "canvas" || entry.kind === "text") {
        // For canvas + atomic-text we open a per-file structural session;
        // its `synced` handler writes the merged content to disk.
        if (!this.app.vault.getAbstractFileByPath(path)) {
          await this.app.vault.create(path, entry.kind === "canvas" ? "{}" : "");
          console.log(`[collab] reconcile: created ${entry.kind} file ${path}`);
        }
        this.openStructuralSession(path, entry.kind);
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

  // ── structural sessions (canvas / atomic-text) ─────────────────────────────

  private openStructuralSession(path: string, kind: "canvas" | "text") {
    if (!this.socket) return;
    if (this.structuralSessions.has(path)) return;

    if (kind === "canvas") this.openCanvasSession(path);
    else this.openAtomicTextSession(path);
  }

  // Canvas: structural CRDT. Each node and edge is a Y.Map keyed by its id,
  // so concurrent edits to different nodes merge cleanly. The JSON we write
  // to disk is composed from the Y.Maps — it is always well-formed.
  private openCanvasSession(path: string) {
    const room = pathToRoom(path);
    const ydoc = new Y.Doc();
    const nodes = ydoc.getMap<Y.Map<unknown>>("canvas.nodes");
    const edges = ydoc.getMap<Y.Map<unknown>>("canvas.edges");
    const meta = ydoc.getMap<unknown>("canvas.meta");

    const provider = new HocuspocusProvider({
      websocketProvider: this.socket!,
      name: room,
      document: ydoc,
      token: this.settings.authToken || undefined,
    });
    provider.attach();

    const persistence = new IndexeddbPersistence(
      `obsidian-collab::${this.settings.serverUrl}::${room}`,
      ydoc,
    );

    const session: CanvasSession = {
      kind: "canvas",
      filePath: path,
      ydoc,
      provider,
      persistence,
      nodes,
      edges,
      meta,
      lastSerialized: "",
      deepObserver: () => {},
    };

    // Y.Doc → disk: any change to nodes/edges/meta serialises the canvas
    // and (if different) writes it to disk.
    const onDeepChange = () => {
      const json = this.buildCanvasJsonFromY(session);
      const serialized = JSON.stringify(json, null, "\t");
      if (serialized === session.lastSerialized) return;
      session.lastSerialized = serialized;
      void this.writeStructuralFile(path, serialized);
    };
    nodes.observeDeep(onDeepChange);
    edges.observeDeep(onDeepChange);
    meta.observeDeep(onDeepChange);
    session.deepObserver = () => {
      nodes.unobserveDeep(onDeepChange);
      edges.unobserveDeep(onDeepChange);
      meta.unobserveDeep(onDeepChange);
    };

    provider.on("synced", async () => {
      const file = this.app.vault.getAbstractFileByPath(path);
      const hasYState = nodes.size > 0 || edges.size > 0 || meta.size > 0;
      if (!hasYState && file instanceof TFile) {
        // First client — seed Y from disk.
        try {
          const raw = await this.app.vault.read(file);
          if (raw.trim().length > 0) {
            const parsed = this.safeParseCanvas(raw, path);
            if (parsed) this.applyCanvasJsonToY(parsed, session);
            session.lastSerialized = JSON.stringify(this.buildCanvasJsonFromY(session), null, "\t");
          }
        } catch (err) {
          console.warn("[collab] canvas seed failed", path, err);
        }
      } else if (hasYState && file instanceof TFile) {
        // Server has state — write the merged canvas to disk.
        const json = this.buildCanvasJsonFromY(session);
        const serialized = JSON.stringify(json, null, "\t");
        session.lastSerialized = serialized;
        try {
          const current = await this.app.vault.read(file);
          if (current !== serialized) {
            this.remoteApplyPaths.add(path);
            await this.app.vault.modify(file, serialized);
            setTimeout(() => this.remoteApplyPaths.delete(path), SUPPRESS_HOLD_MS);
          }
        } catch (err) {
          console.warn("[collab] canvas initial write failed", path, err);
        }
      }
      console.log(`[collab] canvas session "${path}" synced (nodes=${nodes.size}, edges=${edges.size})`);
    });

    this.structuralSessions.set(path, session);
    console.log(`[collab] opened canvas session for ${path}`);
  }

  // Atomic text: one Y.Map cell holds the whole file content. Saves replace
  // the entire string, so the resulting file never has half-written state.
  private openAtomicTextSession(path: string) {
    const room = pathToRoom(path);
    const ydoc = new Y.Doc();
    const doc = ydoc.getMap<string>("atomic");

    const provider = new HocuspocusProvider({
      websocketProvider: this.socket!,
      name: room,
      document: ydoc,
      token: this.settings.authToken || undefined,
    });
    provider.attach();

    const persistence = new IndexeddbPersistence(
      `obsidian-collab::${this.settings.serverUrl}::${room}`,
      ydoc,
    );

    const session: AtomicTextSession = {
      kind: "atomic",
      filePath: path,
      ydoc,
      provider,
      persistence,
      doc,
      lastSynced: "",
      observer: () => {},
    };

    const onChange = () => {
      const next = doc.get("content") ?? "";
      if (next === session.lastSynced) return;
      session.lastSynced = next;
      void this.writeStructuralFile(path, next);
    };
    doc.observe(onChange);
    session.observer = onChange;

    provider.on("synced", async () => {
      const remoteContent = doc.get("content") ?? "";
      const file = this.app.vault.getAbstractFileByPath(path);
      if (remoteContent.length === 0 && file instanceof TFile) {
        try {
          const localContent = await this.app.vault.read(file);
          if (localContent.length > 0) doc.set("content", localContent);
          session.lastSynced = doc.get("content") ?? "";
        } catch (err) {
          console.warn("[collab] atomic seed failed", path, err);
        }
      } else if (file instanceof TFile) {
        session.lastSynced = remoteContent;
        try {
          const localContent = await this.app.vault.read(file);
          if (localContent !== remoteContent) {
            this.remoteApplyPaths.add(path);
            await this.app.vault.modify(file, remoteContent);
            setTimeout(() => this.remoteApplyPaths.delete(path), SUPPRESS_HOLD_MS);
          }
        } catch (err) {
          console.warn("[collab] atomic initial write failed", path, err);
        }
      }
      console.log(`[collab] atomic session "${path}" synced (${remoteContent.length} chars)`);
    });

    this.structuralSessions.set(path, session);
    console.log(`[collab] opened atomic session for ${path}`);
  }

  private closeStructuralSession(path: string) {
    const session = this.structuralSessions.get(path);
    if (!session) return;
    if (session.kind === "canvas") {
      session.deepObserver();
    } else {
      session.doc.unobserve(session.observer);
    }
    void session.persistence.destroy();
    session.provider.destroy();
    session.ydoc.destroy();
    this.structuralSessions.delete(path);
  }

  private async writeStructuralFile(path: string, content: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    try {
      const current = await this.app.vault.read(file);
      if (current === content) return;
      this.remoteApplyPaths.add(path);
      await this.app.vault.modify(file, content);
      console.log(`[collab] structural → disk: ${path} (${content.length} chars)`);
    } catch (err) {
      console.warn("[collab] structural write failed", path, err);
    } finally {
      setTimeout(() => this.remoteApplyPaths.delete(path), SUPPRESS_HOLD_MS);
    }
  }

  // ── canvas (de)serialisation ──────────────────────────────────────────────

  private safeParseCanvas(raw: string, path: string): CanvasJson | null {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return null;
      return parsed as CanvasJson;
    } catch (err) {
      console.warn(`[collab] cannot parse canvas ${path} — skipping until next save`, err);
      return null;
    }
  }

  // Apply a parsed canvas JSON onto our Y.Doc, diffing per-node so the CRDT
  // history records only what actually changed.
  private applyCanvasJsonToY(json: CanvasJson, session: CanvasSession) {
    session.ydoc.transact(() => {
      // Nodes
      const incomingNodeIds = new Set<string>();
      for (const n of json.nodes ?? []) {
        if (!n || typeof n.id !== "string") continue;
        incomingNodeIds.add(n.id);
        let map = session.nodes.get(n.id);
        if (!map) {
          map = new Y.Map();
          session.nodes.set(n.id, map);
        }
        const { id: _id, ...rest } = n;
        void _id;
        this.diffApplyMap(map, rest);
      }
      for (const id of Array.from(session.nodes.keys())) {
        if (!incomingNodeIds.has(id)) session.nodes.delete(id);
      }
      // Edges
      const incomingEdgeIds = new Set<string>();
      for (const e of json.edges ?? []) {
        if (!e || typeof e.id !== "string") continue;
        incomingEdgeIds.add(e.id);
        let map = session.edges.get(e.id);
        if (!map) {
          map = new Y.Map();
          session.edges.set(e.id, map);
        }
        const { id: _id, ...rest } = e;
        void _id;
        this.diffApplyMap(map, rest);
      }
      for (const id of Array.from(session.edges.keys())) {
        if (!incomingEdgeIds.has(id)) session.edges.delete(id);
      }
      // Top-level meta (anything else)
      const metaIncoming: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(json)) {
        if (key === "nodes" || key === "edges") continue;
        metaIncoming[key] = value;
      }
      this.diffApplyMap(session.meta, metaIncoming);
    });
  }

  // Set every (key,value) from `src` into `target` if changed; delete keys
  // in `target` that are absent from `src`. Equality is JSON-based — Canvas
  // values are primitives + plain objects, so this is fine and stable.
  private diffApplyMap(target: Y.Map<unknown>, src: Record<string, unknown>) {
    for (const [key, value] of Object.entries(src)) {
      const cur = target.get(key);
      if (JSON.stringify(cur) !== JSON.stringify(value)) target.set(key, value);
    }
    for (const key of Array.from(target.keys())) {
      if (!(key in src)) target.delete(key);
    }
  }

  // Serialise the Y.Doc state into Canvas JSON.
  private buildCanvasJsonFromY(session: CanvasSession): CanvasJson {
    const out: CanvasJson = { nodes: [], edges: [] };
    for (const [key, value] of session.meta.entries()) {
      if (key === "nodes" || key === "edges") continue;
      (out as Record<string, unknown>)[key] = value;
    }
    // Stable order: sort by id so the serialised string is deterministic.
    const nodeIds = Array.from(session.nodes.keys()).sort();
    for (const id of nodeIds) {
      const map = session.nodes.get(id);
      if (!map) continue;
      const obj: Record<string, unknown> = { id };
      for (const [k, v] of map.entries()) obj[k] = v;
      out.nodes.push(obj);
    }
    const edgeIds = Array.from(session.edges.keys()).sort();
    for (const id of edgeIds) {
      const map = session.edges.get(id);
      if (!map) continue;
      const obj: Record<string, unknown> = { id };
      for (const [k, v] of map.entries()) obj[k] = v;
      out.edges.push(obj);
    }
    return out;
  }

  // Local modify of a canvas: re-parse the file, diff it onto Y.Doc.
  private async updateCanvasFromDisk(file: TFile) {
    let session = this.structuralSessions.get(file.path);
    if (!session) {
      this.openCanvasSession(file.path);
      session = this.structuralSessions.get(file.path);
      if (!session || session.kind !== "canvas") return;
    } else if (session.kind !== "canvas") {
      return; // shouldn't happen — classify guards this
    }
    try {
      const raw = await this.app.vault.read(file);
      const next = JSON.stringify(this.safeParseCanvas(raw, file.path), null, "\t");
      if (next === session.lastSerialized) return;
      const parsed = this.safeParseCanvas(raw, file.path);
      if (!parsed) return;
      this.applyCanvasJsonToY(parsed, session);
      session.lastSerialized = JSON.stringify(this.buildCanvasJsonFromY(session), null, "\t");
    } catch (err) {
      console.warn("[collab] canvas read-from-disk failed", file.path, err);
    }
  }

  // Local modify of an atomic file: drop the whole new content into the map.
  private async updateAtomicFromDisk(file: TFile) {
    let session = this.structuralSessions.get(file.path);
    if (!session) {
      this.openAtomicTextSession(file.path);
      session = this.structuralSessions.get(file.path);
      if (!session || session.kind !== "atomic") return;
    } else if (session.kind !== "atomic") {
      return;
    }
    try {
      const content = await this.app.vault.read(file);
      if (content === session.lastSynced) return;
      session.doc.set("content", content);
      session.lastSynced = content;
    } catch (err) {
      console.warn("[collab] atomic read-from-disk failed", file.path, err);
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
    if ((kind === "canvas" || kind === "text") && file instanceof TFile) {
      this.openStructuralSession(file.path, kind);
    }
  }

  private onLocalVaultDelete(file: TAbstractFile) {
    if (!this.manifestMap || !this.manifestBinaries || !this.manifestTrash || !this.manifestYDoc) return;
    if (this.remoteApplyPaths.has(file.path)) return;
    const entry = this.manifestMap.get(file.path);
    if (!entry) return;
    // Tear down any structural session before forgetting the path.
    if (entry.kind === "canvas" || entry.kind === "text") this.closeStructuralSession(file.path);
    // Move into trash with a UUID so the original path can later be reused
    // for a new file without clobbering the soft-deleted copy.
    const uuid = (globalThis.crypto?.randomUUID?.()) ?? `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.manifestYDoc.transact(() => {
      this.manifestMap!.delete(file.path);
      this.manifestTrash!.set(uuid, {
        uuid,
        originalPath: file.path,
        kind: entry.kind,
        deletedAt: Date.now(),
      });
      const bytes = this.manifestBinaries!.get(file.path);
      if (bytes) {
        this.manifestBinaries!.delete(file.path);
        this.manifestBinaries!.set(`trash:${uuid}`, bytes);
      }
    });
    console.log(`[collab] soft-deleted ${file.path} → trash:${uuid}`);
  }

  private onLocalVaultRename(file: TAbstractFile, oldPath: string) {
    if (!this.manifestMap || !this.manifestBinaries || !this.manifestYDoc) return;
    if (this.remoteApplyPaths.has(file.path) || this.remoteApplyPaths.has(oldPath)) return;
    const kind = this.classify(file);
    if (!kind) return;
    // If a structural session was watching the old path, move it.
    if (kind === "canvas" || kind === "text") {
      this.closeStructuralSession(oldPath);
      this.openStructuralSession(file.path, kind);
    }
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
    if (file.extension === "md") return; // markdown content syncs via editor binding
    if (!this.manifestMap || !this.manifestBinaries) return;
    if (this.remoteApplyPaths.has(file.path)) return;
    const kind = this.classify(file);
    if (kind === "canvas") {
      void this.updateCanvasFromDisk(file);
      return;
    }
    if (kind === "text") {
      void this.updateAtomicFromDisk(file);
      return;
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// trash modal — lists soft-deleted entries with a restore action each
// ─────────────────────────────────────────────────────────────────────────────

class TrashModal extends Modal {
  constructor(
    app: App,
    private readonly trash: Y.Map<TrashEntry>,
    private readonly onRestore: (uuid: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Deleted files" });

    const entries = Array.from(this.trash.values()).sort((a, b) => b.deletedAt - a.deletedAt);
    if (entries.length === 0) {
      contentEl.createEl("p", { text: "Trash is empty." });
      return;
    }

    const list = contentEl.createDiv({ cls: "collab-trash-list" });
    for (const entry of entries) {
      const row = list.createDiv({ cls: "collab-trash-row" });
      const ageMs = Date.now() - entry.deletedAt;
      const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      const remainingDays = Math.max(0, 30 - days);
      const info = row.createDiv({ cls: "collab-trash-info" });
      info.createEl("div", { text: entry.originalPath, cls: "collab-trash-path" });
      info.createEl("div", {
        text: `${entry.kind} · deleted ${days}d ago · auto-purge in ${remainingDays}d`,
        cls: "collab-trash-meta",
      });
      const restoreBtn = row.createEl("button", { text: "Restore" });
      restoreBtn.addEventListener("click", async () => {
        restoreBtn.disabled = true;
        await this.onRestore(entry.uuid);
        this.close();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

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
