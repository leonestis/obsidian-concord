// SPDX-License-Identifier: AGPL-3.0-only
//
// Colored console logger. Each log call carries a subsystem tag rendered
// as a colored pill via the dev console's %c styling, so when the
// reader scrolls through a busy log they can pick out which subsystem
// is talking at a glance instead of squinting at "[collab]" prefixes.
//
// Canvas modules (canvas-cursors.ts, canvas-session.ts) are explicitly
// outside the migration boundary — they keep their plain "[collab] …"
// logs because the canvas code is frozen per the v1.0 contract.
//
// `debug` is gated by the plugin's debugLogging setting; pass the
// current value rather than capturing settings at module load (which
// would freeze it stale).

type Sub =
  | "plugin"
  | "sync"
  | "session"
  | "binding"
  | "blob"
  | "socket"
  | "trash"
  | "diag"
  | "presence";

interface SubStyle {
  bg: string;
  fg: string;
}

const STYLES: Record<Sub, SubStyle> = {
  plugin:  { bg: "#666",    fg: "#fff" },
  sync:    { bg: "#1e88e5", fg: "#fff" }, // blue
  session: { bg: "#43a047", fg: "#fff" }, // green
  binding: { bg: "#fb8c00", fg: "#fff" }, // orange
  blob:    { bg: "#8e24aa", fg: "#fff" }, // purple
  socket:  { bg: "#00acc1", fg: "#fff" }, // cyan
  trash:   { bg: "#5d4037", fg: "#fff" }, // brown
  diag:    { bg: "#546e7a", fg: "#fff" }, // blue-gray
  presence:{ bg: "#d81b60", fg: "#fff" }, // pink
};

const RESET = "color: inherit; background: inherit; font-weight: normal";

function tagStyle(sub: Sub): string {
  const s = STYLES[sub];
  return `color: ${s.fg}; background: ${s.bg}; padding: 1px 5px; border-radius: 3px; font-weight: bold`;
}

function fmt(sub: Sub, msg: string): [string, string, string] {
  return [`%c${sub}%c ${msg}`, tagStyle(sub), RESET];
}

export const log = {
  info(sub: Sub, msg: string, ...extra: unknown[]): void {
    const [s, tag, reset] = fmt(sub, msg);
    console.log(s, tag, reset, ...extra);
  },
  warn(sub: Sub, msg: string, ...extra: unknown[]): void {
    const [s, tag, reset] = fmt(sub, msg);
    console.warn(s, tag, reset, ...extra);
  },
  error(sub: Sub, msg: string, ...extra: unknown[]): void {
    const [s, tag, reset] = fmt(sub, msg);
    console.error(s, tag, reset, ...extra);
  },
  // Gated by the plugin's debugLogging setting. Caller passes the
  // current boolean so we never read stale settings.
  debug(enabled: boolean, sub: Sub, msg: string, ...extra: unknown[]): void {
    if (!enabled) return;
    const [s, tag, reset] = fmt(sub, msg);
    console.log(s, tag, reset, ...extra);
  },
};

export type LogSub = Sub;
