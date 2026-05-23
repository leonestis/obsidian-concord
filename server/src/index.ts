import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@hocuspocus/server";
import { SQLite } from "@hocuspocus/extension-sqlite";

const PORT = Number(process.env.PORT ?? 1234);
const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const DB_PATH = resolve(DATA_DIR, "documents.sqlite");

mkdirSync(DATA_DIR, { recursive: true });

const server = new Server({
  port: PORT,
  extensions: [new SQLite({ database: DB_PATH })],
  async onConnect({ documentName }) {
    console.log(`→ client connected to room "${documentName}"`);
  },
  async onDisconnect({ documentName }) {
    console.log(`← client disconnected from room "${documentName}"`);
  },
});

await server.listen();
console.log(`obsidian-collab server listening on ws://localhost:${PORT}`);
console.log(`persistence: ${DB_PATH}`);
