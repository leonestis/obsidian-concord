#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# obsidian-collab — management CLI. Installed to /usr/local/bin/obsidian-collab
# by install.sh. Run with no arguments for an interactive menu, or pass a
# subcommand directly:
#
#   obsidian-collab status | start | stop | restart | logs
#   obsidian-collab token <name> [expiry]   # mint a client JWT (default 365d)
#   obsidian-collab url                      # show the Server URL to paste
#   obsidian-collab update                   # git pull + reinstall + restart
#   obsidian-collab uninstall                # remove service, code, data

set -euo pipefail

INSTALL_DIR="/opt/obsidian-collab"
SERVER_DIR="${INSTALL_DIR}/server"
CONFIG_DIR="/etc/obsidian-collab"
ENV_FILE="${CONFIG_DIR}/env"
SERVICE_NAME="obsidian-collab"
SERVICE_USER="obsidian-collab"
MANAGE_BIN="/usr/local/bin/obsidian-collab"

c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_red=$'\033[31m'; c_cya=$'\033[36m'; c_rst=$'\033[0m'
info() { echo "${c_cya}▸${c_rst} $*"; }
ok()   { echo "${c_grn}✓${c_rst} $*"; }
warn() { echo "${c_yel}!${c_rst} $*"; }
die()  { echo "${c_red}✗ $*${c_rst}" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die "This command needs root (use sudo)."; }

get_env() { grep "^$1=" "${ENV_FILE}" 2>/dev/null | head -1 | cut -d= -f2-; }

cmd_status()  { systemctl status "${SERVICE_NAME}" --no-pager || true; }
cmd_start()   { need_root; systemctl start   "${SERVICE_NAME}"; ok "started"; }
cmd_stop()    { need_root; systemctl stop    "${SERVICE_NAME}"; ok "stopped"; }
cmd_restart() { need_root; systemctl restart "${SERVICE_NAME}"; ok "restarted"; }
cmd_logs()    { journalctl -u "${SERVICE_NAME}" -n 100 -f --no-pager; }

cmd_url() {
  local port domain
  port="$(get_env PORT)"
  if [ -f /etc/caddy/Caddyfile ]; then
    domain="$(awk 'NR==1{print $1}' /etc/caddy/Caddyfile 2>/dev/null | tr -d '{ ')"
  fi
  if [ -n "${domain:-}" ]; then
    echo "wss://${domain}"
  else
    local ip; ip="$(curl -fsSL https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
    echo "ws://${ip}:${port}"
  fi
}

cmd_token() {
  need_root
  local name="${1:-}"; local exp="${2:-365d}"
  [ -n "${name}" ] || die "usage: obsidian-collab token <name> [expiry]"
  local secret; secret="$(get_env JWT_SECRET)"
  [ -n "${secret}" ] || die "JWT_SECRET not found in ${ENV_FILE}"
  local token
  token="$( cd "${SERVER_DIR}" && JWT_SECRET="${secret}" node_modules/.bin/tsx src/gen-token.ts "${name}" "${exp}" )"
  echo
  echo "  token for '${name}' (expires in ${exp}):"
  echo "    ${c_cya}${token}${c_rst}"
  echo
  echo "  Server URL : ${c_cya}$(cmd_url)${c_rst}"
  echo
}

cmd_update() {
  need_root
  info "Pulling latest code…"
  git -C "${INSTALL_DIR}" fetch --quiet --tags origin
  git -C "${INSTALL_DIR}" reset --hard --quiet origin/main
  info "Reinstalling dependencies…"
  ( cd "${SERVER_DIR}" && npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1 )
  install -m 0755 "${SERVER_DIR}/scripts/manage.sh" "${MANAGE_BIN}"
  systemctl restart "${SERVICE_NAME}"
  ok "Updated and restarted."
}

cmd_uninstall() {
  need_root
  read -rp "Remove service and code? Keep data dir? [keep/delete/cancel]: " ans || true
  case "${ans:-cancel}" in
    cancel|"") echo "cancelled"; return 0 ;;
  esac
  systemctl disable --now "${SERVICE_NAME}" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  rm -rf "${INSTALL_DIR}"
  rm -f "${MANAGE_BIN}"
  if [ "${ans}" = "delete" ]; then
    local datadir; datadir="$(get_env DATA_DIR)"
    rm -rf "${datadir}" "${CONFIG_DIR}"
    userdel "${SERVICE_USER}" 2>/dev/null || true
    warn "Removed code, service, data and config."
  else
    warn "Removed code + service. Kept data (${CONFIG_DIR}, $(get_env DATA_DIR))."
  fi
}

menu() {
  echo
  echo "${c_grn}obsidian-collab${c_rst} — management"
  systemctl is-active --quiet "${SERVICE_NAME}" \
    && echo "  status: ${c_grn}running${c_rst}" \
    || echo "  status: ${c_red}stopped${c_rst}"
  echo "  url:    $(cmd_url)"
  echo
  echo "  1) status        5) view logs"
  echo "  2) start         6) make a token"
  echo "  3) stop          7) update"
  echo "  4) restart       8) uninstall"
  echo "  0) exit"
  echo
  read -rp "choose: " ch || true
  case "${ch:-}" in
    1) cmd_status ;;
    2) cmd_start ;;
    3) cmd_stop ;;
    4) cmd_restart ;;
    5) cmd_logs ;;
    6) read -rp "name: " n || true; read -rp "expiry [365d]: " e || true; cmd_token "${n}" "${e:-365d}" ;;
    7) cmd_update ;;
    8) cmd_uninstall ;;
    0|"") exit 0 ;;
    *) warn "unknown choice" ;;
  esac
}

case "${1:-menu}" in
  menu)      menu ;;
  status)    cmd_status ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  logs)      cmd_logs ;;
  url)       cmd_url ;;
  token)     shift; cmd_token "$@" ;;
  update)    cmd_update ;;
  uninstall) cmd_uninstall ;;
  -h|--help|help)
    grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -20 ;;
  *) die "unknown command '$1' (try: obsidian-collab help)" ;;
esac
