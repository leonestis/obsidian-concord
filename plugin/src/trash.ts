// SPDX-License-Identifier: AGPL-3.0-only
//
// Trash log. v1.0 removes the byte-preservation + restore feature
// that 0.9.x had — restore turned out to be a perpetual source of
// edge-case bugs around path collisions, cross-room byte moves, and
// stale trash entries pointing at long-dead Y.Doc rooms. Now the
// trash map is purely informational: a record of what was deleted,
// when, and (when known) the original docId / hash so a future
// hypothetical v1.x restore could rebuild from server data.
//
// Display lives in a slim Modal — no restore button, just a note
// pointing the user at their vault backup if they actually need the
// file back.

import { App, Modal } from "obsidian";
import * as Y from "yjs";

import type { TrashEntry } from "./types";

// Soft-deleted entries linger this long before any client purges them
// on connect. 30 days mirrors most cloud trash bins.
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function purgeOldTrash(
  doc: Y.Doc,
  trash: Y.Map<TrashEntry>,
): number {
  const now = Date.now();
  const toDrop: string[] = [];
  for (const [id, entry] of trash.entries()) {
    if (now - entry.deletedAt > TRASH_RETENTION_MS) toDrop.push(id);
  }
  if (toDrop.length === 0) return 0;
  doc.transact(() => {
    for (const id of toDrop) trash.delete(id);
  });
  return toDrop.length;
}

export class TrashModal extends Modal {
  constructor(
    app: App,
    private readonly trash: Y.Map<TrashEntry>,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Deleted files" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Restore was removed in v1.0 — restore from your vault backups instead. This list is informational only.",
    });

    const entries = Array.from(this.trash.values()).sort(
      (a, b) => b.deletedAt - a.deletedAt,
    );
    if (entries.length === 0) {
      contentEl.createEl("p", { text: "Trash is empty." });
      return;
    }

    const list = contentEl.createDiv({ cls: "collab-trash-list" });
    for (const entry of entries) {
      const row = list.createDiv({ cls: "collab-trash-row" });
      const ageMs = Date.now() - entry.deletedAt;
      const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      const remainingDays = Math.max(
        0,
        Math.ceil(TRASH_RETENTION_MS / (24 * 60 * 60 * 1000)) - days,
      );
      const info = row.createDiv({ cls: "collab-trash-info" });
      info.createEl("div", { text: entry.path, cls: "collab-trash-path" });
      info.createEl("div", {
        text:
          `${entry.kind} · deleted ${days}d ago · auto-purge in ${remainingDays}d` +
          (entry.deletedBy ? ` · by ${entry.deletedBy}` : ""),
        cls: "collab-trash-meta",
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
