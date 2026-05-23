import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@hocuspocus/server";
import { SQLite } from "@hocuspocus/extension-sqlite";
import jwt from "jsonwebtoken";

const PORT = Number(process.env.PORT ?? 1234);
const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const DB_PATH = resolve(DATA_DIR, "documents.sqlite");
const JWT_SECRET = process.env.JWT_SECRET ?? "";

mkdirSync(DATA_DIR, { recursive: true });

if (!JWT_SECRET) {
  console.warn("⚠️  JWT_SECRET is not set — running in UNAUTHENTICATED mode (anyone can connect).");
} else {
  console.log("🔐 JWT authentication is REQUIRED (JWT_SECRET is set).");
}

const server = new Server({
  port: PORT,
  extensions: [new SQLite({ database: DB_PATH })],

  // When JWT_SECRET is set, every client must present a valid token in the
  // HocuspocusProvider `token` option. Verified tokens are returned as the
  // connection context so downstream hooks can read e.g. ctx.user.name.
  async onAuthenticate({ token }) {
    if (!JWT_SECRET) return {}; // auth disabled
    if (!token) throw new Error("auth required: no token");
    try {
      const payload = jwt.verify(token, JWT_SECRET) as Record<string, unknown>;
      return { user: payload };
    } catch (err) {
      throw new Error(`auth failed: ${(err as Error).message}`);
    }
  },

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
