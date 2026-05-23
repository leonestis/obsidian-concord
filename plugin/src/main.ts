import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

interface CollabSettings {
  serverUrl: string;
  testFile: string;
  roomName: string;
}

const DEFAULT_SETTINGS: CollabSettings = {
  serverUrl: "ws://localhost:1234",
  testFile: "shared.md",
  roomName: "shared",
};

interface Session {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  destroy: () => void;
}

export default class CollabPlugin extends Plugin {
  settings!: CollabSettings;
  private session: Session | null = null;

  async onload() {
    await this.loadSettings();
    console.log("[collab] plugin loaded");

    this.addSettingTab(new CollabSettingTab(this.app, this));

    this.addCommand({
      id: "collab-connect",
      name: "Connect to server (test file)",
      callback: () => this.connect(),
    });

    this.addCommand({
      id: "collab-disconnect",
      name: "Disconnect",
      callback: () => this.disconnect(),
    });
  }

  async onunload() {
    this.disconnect();
    console.log("[collab] plugin unloaded");
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private connect() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Open a markdown file first");
      return;
    }
    if (view.file?.path !== this.settings.testFile) {
      new Notice(`MVP only syncs "${this.settings.testFile}". Create/open that file first.`);
      return;
    }
    if (this.session) {
      new Notice("Already connected — disconnect first");
      return;
    }

    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(this.settings.serverUrl, this.settings.roomName, ydoc);
    const ytext = ydoc.getText("content");

    provider.on("status", (event: { status: string }) => {
      console.log(`[collab] ws status: ${event.status}`);
    });

    const editorView = (view.editor as unknown as { cm: EditorView }).cm;

    editorView.dispatch({
      effects: StateEffect.appendConfig.of(yCollab(ytext, provider.awareness)),
    });

    this.session = {
      ydoc,
      provider,
      destroy: () => {
        provider.destroy();
        ydoc.destroy();
      },
    };

    new Notice(`Connected → ${this.settings.serverUrl} (room: ${this.settings.roomName})`);
  }

  private disconnect() {
    if (!this.session) {
      new Notice("Not connected");
      return;
    }
    this.session.destroy();
    this.session = null;
    new Notice("Disconnected");
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
      .setDesc("WebSocket URL of the Hocuspocus server. Use ws:// for plain or wss:// for TLS.")
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
      .setName("Test file")
      .setDesc("Relative path inside the vault. Only this file is synced in MVP.")
      .addText((text) =>
        text
          .setPlaceholder("shared.md")
          .setValue(this.plugin.settings.testFile)
          .onChange(async (value) => {
            this.plugin.settings.testFile = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Room name")
      .setDesc("Yjs room identifier. All clients with the same room name share the same document.")
      .addText((text) =>
        text
          .setPlaceholder("shared")
          .setValue(this.plugin.settings.roomName)
          .onChange(async (value) => {
            this.plugin.settings.roomName = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("p", {
      text: "Restart any active connection (Disconnect → Connect) for changes to take effect.",
      cls: "setting-item-description",
    });
  }
}
