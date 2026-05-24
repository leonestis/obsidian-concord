import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@hocuspocus/server";
import { SQLite } from "@hocuspocus/extension-sqlite";
import jwt from "jsonwebtoken";

const PORT = Number(process.env.PORT ?? 1234);
const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const DB_PATH = resolve(DATA_DIR, "documents.sqlite");
const JWT_SECRET = process.env.JWT_SECRET ?? "";

// Plugin versions strictly below this are rejected at the WebSocket
// handshake. Bump it any time we ship a fix that older clients lack
// and that could corrupt shared data if they keep writing. Older
// clients see a connection error and a server-side log entry — they
// cannot pollute the CRDT.
const MIN_CLIENT_VERSION = process.env.MIN_CLIENT_VERSION ?? "0.6.2";

mkdirSync(DATA_DIR, { recursive: true });

if (!JWT_SECRET) {
  console.warn("⚠️  JWT_SECRET is not set — running in UNAUTHENTICATED mode (anyone can connect).");
} else {
  console.log("🔐 JWT authentication is REQUIRED (JWT_SECRET is set).");
}
console.log(`🧱 Minimum accepted client version: ${MIN_CLIENT_VERSION}`);

// Tiny semver comparator: returns -1 / 0 / 1 like String.localeCompare.
// We only care about the dotted-numeric part — pre-release suffixes are
// ignored. Robust enough for our "is this client too old?" question.
function compareVersions(a: string, b: string): number {
  const parts = (s: string) =>
    s
      .replace(/^v/, "")
      .split(/[-+]/, 1)[0]
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function readClientVersion(requestParameters: unknown): string {
  if (
    requestParameters &&
    typeof (requestParameters as URLSearchParams).get === "function"
  ) {
    return (requestParameters as URLSearchParams).get("clientVersion") ?? "";
  }
  return "";
}

const server = new Server({
  port: PORT,
  extensions: [new SQLite({ database: DB_PATH })],

  // Refuse clients on versions known to corrupt the CRDT. Throwing here
  // closes the WebSocket before any sync messages flow.
  async onConnect({ documentName, requestParameters }) {
    const clientVersion = readClientVersion(requestParameters);
    if (
      !clientVersion ||
      compareVersions(clientVersion, MIN_CLIENT_VERSION) < 0
    ) {
      console.warn(
        `✋ rejecting connection: clientVersion="${clientVersion || "(none)"}" < ${MIN_CLIENT_VERSION} (room "${documentName}")`,
      );
      throw new Error(
        `obsidian-collab: client version ${clientVersion || "unknown"} is too old. ` +
          `Update the plugin to ${MIN_CLIENT_VERSION} or newer.`,
      );
    }
    console.log(
      `→ client v${clientVersion} connected to room "${documentName}"`,
    );
  },

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

  async onDisconnect({ documentName }) {
    console.log(`← client disconnected from room "${documentName}"`);
  },
});

await server.listen();
console.log(`obsidian-collab server listening on ws://localhost:${PORT}`);
console.log(`persistence: ${DB_PATH}`);
