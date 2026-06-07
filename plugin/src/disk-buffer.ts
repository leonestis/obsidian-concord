// SPDX-License-Identifier: AGPL-3.0-only
//
// DiskBuffer — the "last content we saw that was in sync" snapshot, one
// per document, persisted across plugin reloads.
//
// WHY THIS EXISTS (Phase 3, FIX 1)
//
// When a markdown file's local content diverges from the server's
// Y.Text — the user edited offline, or via another app, or while
// disconnected — opening the file used to make the editor silently
// adopt the server version, destroying the local edits (the dreaded
// case (c) in y-sync.ts). The fix is a three-way merge:
//
//     OURS   = current Y.Text content
//     THEIRS = current disk / editor content
//     BASE   = the last disk content known to be consistent with the
//              Y.Text  ← THIS is what DiskBuffer stores
//
// With BASE we can diff base→editor to recover exactly the LOCAL edits
// made since the last sync, replay them onto the (possibly remotely
// advanced) Y.Text, and let Yjs merge them with concurrent remote ops.
// Both sides survive. Without BASE we fall back to an additive merge
// that may duplicate in the rare true-conflict case but NEVER loses
// text.
//
// KEYING. Keyed by docId (the file's stable UUID), never by path, so a
// rename doesn't orphan the buffer. The docId is the same UUID used for
// the Y.Doc room name (see util.docIdToRoom).
//
// STORAGE. A dedicated IndexedDB database, separate from y-indexeddb's
// document stores, so wiping the CRDT cache (the "wipe local cache"
// command) doesn't take the merge bases with it unless we explicitly
// want it to. Raw IndexedDB, no extra dependency, ~one object store.

const DB_NAME = "concord-diskbuffer";
const DB_VERSION = 1;
const STORE = "buffers";

interface DiskBufferRecord {
  // The keyPath. docId (file UUID).
  docId: string;
  content: string;
  updatedAt: number;
}

export class DiskBuffer {
  // One IDBDatabase handle shared by every caller in the process. Opened
  // lazily on first use; the promise is cached so concurrent callers
  // share the same open request rather than racing multiple upgrades.
  private dbPromise: Promise<IDBDatabase> | null = null;

  // Module singleton. text-session.ts (disk-sync writer) and
  // yedit/y-sync.ts (merge-on-bind) both reach for the same instance so
  // they share one IndexedDB connection.
  private static instance: DiskBuffer | null = null;
  static shared(): DiskBuffer {
    if (!DiskBuffer.instance) DiskBuffer.instance = new DiskBuffer();
    return DiskBuffer.instance;
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "docId" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // If another tab/process bumps the version (future schema
        // change), close our handle so we don't block their upgrade and
        // so the next open() re-establishes a fresh one.
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            /* ignore */
          }
          this.dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => {
        // A prior connection with a lower version is blocking the
        // upgrade. We don't reject — onsuccess will fire once it clears.
        // (Logged at call sites if the await never resolves.)
      };
    });
    // If the open fails, drop the cached rejected promise so a later
    // call can retry rather than being stuck on the failure forever.
    this.dbPromise.catch(() => {
      this.dbPromise = null;
    });
    return this.dbPromise;
  }

  // Last-known-consistent disk content for this doc, or null if we've
  // never recorded one (first-ever open on this device).
  async get(docId: string): Promise<string | null> {
    let db: IDBDatabase;
    try {
      db = await this.open();
    } catch (err) {
      console.warn("[collab] DiskBuffer.get: open failed", err);
      return null;
    }
    return new Promise<string | null>((resolve) => {
      try {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(docId);
        req.onsuccess = () => {
          const rec = req.result as DiskBufferRecord | undefined;
          resolve(rec ? rec.content : null);
        };
        req.onerror = () => {
          console.warn("[collab] DiskBuffer.get: read failed", req.error);
          resolve(null);
        };
      } catch (err) {
        console.warn("[collab] DiskBuffer.get: txn failed", err);
        resolve(null);
      }
    });
  }

  // Record the content we now consider the in-sync base for this doc.
  // Called after a successful merge and after every disk-sync write.
  async set(docId: string, content: string): Promise<void> {
    let db: IDBDatabase;
    try {
      db = await this.open();
    } catch (err) {
      console.warn("[collab] DiskBuffer.set: open failed", err);
      return;
    }
    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        const rec: DiskBufferRecord = {
          docId,
          content,
          updatedAt: Date.now(),
        };
        tx.objectStore(STORE).put(rec);
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          console.warn("[collab] DiskBuffer.set: write failed", tx.error);
          resolve();
        };
        tx.onabort = () => {
          console.warn("[collab] DiskBuffer.set: txn aborted", tx.error);
          resolve();
        };
      } catch (err) {
        console.warn("[collab] DiskBuffer.set: txn failed", err);
        resolve();
      }
    });
  }

  // Drop the buffer for a doc. Called when a file is deleted so we don't
  // keep a stale base around for a docId that will never reappear (UUIDs
  // are never reused, so this is just housekeeping — but it keeps the DB
  // from growing without bound). Wired from ManifestSync.onLocalDelete.
  async delete(docId: string): Promise<void> {
    let db: IDBDatabase;
    try {
      db = await this.open();
    } catch (err) {
      console.warn("[collab] DiskBuffer.delete: open failed", err);
      return;
    }
    return new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(docId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          console.warn("[collab] DiskBuffer.delete: failed", tx.error);
          resolve();
        };
        tx.onabort = () => resolve();
      } catch (err) {
        console.warn("[collab] DiskBuffer.delete: txn failed", err);
        resolve();
      }
    });
  }
}
