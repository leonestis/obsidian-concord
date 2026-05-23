# obsidian-collab

Self-hosted realtime collaboration plugin for [Obsidian](https://obsidian.md).

Open-source alternative to Relay and Peerdraft. Live cursors, selections, and concurrent editing — all running on your own infrastructure.

## Status

🚧 **Early development.** Not yet usable.

## What it does

- See your teammates' cursors and selections in real time as they edit shared notes.
- Concurrent edits merge without conflicts (CRDT under the hood — [Yjs](https://yjs.dev)).
- Runs entirely on infrastructure you control. No cloud account required.

## Architecture

```
Obsidian + plugin  <--WebSocket-->  Hocuspocus server  <-->  SQLite
```

- **Plugin:** TypeScript, embeds Yjs into Obsidian's CodeMirror editor.
- **Server:** [Hocuspocus](https://tiptap.dev/docs/hocuspocus) — a Yjs collaboration backend on Node.js.
- **Storage:** SQLite for document state on the server.
- **TLS:** terminated by Caddy or nginx in front of the server.

## Repository layout

```
obsidian-collab/
├── plugin/    # Obsidian plugin (TypeScript)
├── server/    # Hocuspocus server (TypeScript / Node.js)
├── docs/      # Self-hosting and contributor docs
└── LICENSE    # AGPL-3.0
```

## Self-hosting

Documentation will live in [docs/](docs/) once the first usable version ships.

## License

[AGPL-3.0](LICENSE). If you run a modified version of this software and let others use it over a network, you must make your modified source available to those users.
