import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@hocuspocus/server";
import { SQLite } from "@hocuspocus/extension-sqlite";
import jwt from "jsonwebtoken";

const PORT = Number(process.env.PORT ?? 1234);
const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const DB_PATH = resolve(DATA_DIR, "documents.sqlite");
const JWT_SECRET = process.env.JWT_SECRET ?? "";

const MIN_CLIENT_VERSION = process.env.MIN_CLIENT_VERSION ?? "0.9.0";

mkdirSync(DATA_DIR, { recursive: true });

if (!JWT_SECRET) {
  console.warn("⚠️  JWT_SECRET is not set — running in UNAUTHENTICATED mode (anyone can connect).");
} else {
  console.log("🔐 JWT authentication is REQUIRED (JWT_SECRET is set).");
}
console.log(`🧱 Minimum accepted client version: ${MIN_CLIENT_VERSION}`);

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

// Wraps SQLite to log every fetch / store. If `store` isn't called,
// we'll see silence; if it is called and the file doesn't grow, the
// problem is in better-sqlite3 or filesystem.
const sqlite = new SQLite({ database: DB_PATH });
const origConfig = (sqlite as any).configuration;
const wrappedFetch = origConfig.fetch;
const wrappedStore = origConfig.store;
(sqlite as any).configuration = {
  ...origConfig,
  fetch: async (data: { documentName: string }) => {
    try {
      const result = await wrappedFetch(data);
      console.log(`💾 FETCH "${data.documentName}" → ${result ? `${result.length} bytes` : "nothing"}`);
      return result;
    } catch (err) {
      console.error(`💥 FETCH failed for "${data.documentName}":`, err);
      throw err;
    }
  },
  store: async (data: { documentName: string; state: Buffer }) => {
    const before = (() => { try { return statSync(DB_PATH).size; } catch { return -1; } })();
    try {
      await wrappedStore(data);
      const after = (() => { try { return statSync(DB_PATH).size; } catch { return -1; } })();
      console.log(`💾 STORE "${data.documentName}" ${data.state.length} bytes → sqlite ${before}→${after} bytes`);
    } catch (err) {
      console.error(`💥 STORE failed for "${data.documentName}":`, err);
      throw err;
    }
  },
};

const server = new Server({
  port: PORT,
  extensions: [sqlite],

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

  async onChange({ documentName, clientsCount, update }) {
    console.log(`📝 CHANGE in "${documentName}" (update=${update.length}b, clients=${clientsCount})`);
  },

  async onStoreDocument({ documentName, clientsCount }) {
    console.log(`📌 onStoreDocument hook fired: "${documentName}" (clients=${clientsCount})`);
  },

  async onAuthenticate({ token }) {
    if (!JWT_SECRET) return {};
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
