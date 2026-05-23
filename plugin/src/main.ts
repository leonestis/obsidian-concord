import { MarkdownView, Notice, Plugin } from "obsidian";
import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

const SERVER_URL = "ws://localhost:1234";
const TEST_FILE = "shared.md";
const ROOM_NAME = "shared";

interface Session {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  destroy: () => void;
}

export default class CollabPlugin extends Plugin {
  private session: Session | null = null;

  async onload() {
    console.log("[collab] plugin loaded");

    this.addCommand({
      id: "collab-connect",
      name: "Connect shared.md to server (test)",
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

  private connect() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice("Open a markdown file first");
      return;
    }
    if (view.file?.path !== TEST_FILE) {
      new Notice(`MVP only syncs "${TEST_FILE}". Create/open that file first.`);
      return;
    }
    if (this.session) {
      new Notice("Already connected — disconnect first");
      return;
    }

    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(SERVER_URL, ROOM_NAME, ydoc);
    const ytext = ydoc.getText("content");

    provider.on("status", (event: { status: string }) => {
      console.log(`[collab] ws status: ${event.status}`);
    });

    const editorView = (view.editor as unknown as { cm: EditorView }).cm;

    // Dynamically inject the y-codemirror collab extension into THIS editor.
    // appendConfig.of() lets us add extensions to an already-running EditorView.
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

    new Notice(`Connected → ${SERVER_URL} (room: ${ROOM_NAME})`);
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
