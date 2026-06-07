#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# concord — one-command server installer (Debian/Ubuntu).
#
# Usage (as root):
#   bash <(curl -fsSL https://raw.githubusercontent.com/leonestis/obsidian-concord/main/server/scripts/install.sh)
#
# Non-interactive (env vars override the prompts):
#   DOMAIN=collab.example.com PORT=1234 bash <(curl -fsSL .../install.sh)
#
# What it does:
#   1. Installs Node.js 20 (NodeSource), git, ufw and build tools.
#   2. Clones the repo to /opt/concord and installs server deps.
#   3. Generates a JWT secret → /etc/concord/env.
#   4. Creates a dedicated `concord` system user + data dir.
#   5. Installs and starts a systemd service (auto-restart, auto-boot).
#   6. If a DOMAIN is given: installs Caddy → automatic HTTPS (wss://).
#      Otherwise: opens the port in ufw and serves plain ws:// by IP.
#   7. Mints a first client token and prints the exact Server URL + token
#      to paste into the Collab plugin settings.
#   8. Installs an `concord` management command (menu + subcommands).
#
# Re-running is safe: it updates an existing install in place.

set -euo pipefail

# ── constants ─────────────────────────────────────────────────────────
REPO_URL="https://github.com/leonestis/obsidian-concord.git"
INSTALL_DIR="/opt/concord"
SERVER_DIR="${INSTALL_DIR}/server"
CONFIG_DIR="/etc/concord"
ENV_FILE="${CONFIG_DIR}/env"
DATA_DIR_DEFAULT="/var/lib/concord"
SERVICE_USER="concord"
SERVICE_NAME="concord"
MANAGE_BIN="/usr/local/bin/concord"
NODE_MAJOR="20"

# ── pretty output ─────────────────────────────────────────────────────
c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_red=$'\033[31m'; c_cya=$'\033[36m'; c_rst=$'\033[0m'
info() { echo "${c_cya}▸${c_rst} $*"; }
ok()   { echo "${c_grn}✓${c_rst} $*"; }
warn() { echo "${c_yel}!${c_rst} $*"; }
die()  { echo "${c_red}✗ $*${c_rst}" >&2; exit 1; }

# ── preflight ─────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "Run as root (use sudo)."
command -v apt-get >/dev/null 2>&1 || die "This installer supports Debian/Ubuntu (apt) only."

DOMAIN="${DOMAIN:-}"
PORT="${PORT:-1234}"

# Interactive prompts only when not preset and we have a TTY.
if [ -z "${DOMAIN}" ] && [ -t 0 ]; then
  echo
  echo "Enter a domain name pointed at THIS server to get automatic HTTPS (wss://),"
  echo "or leave blank to serve plain ws:// over the server's IP (testing only —"
  echo "mobile Obsidian may refuse an unencrypted ws:// connection)."
  read -rp "Domain (blank = none): " DOMAIN || true
fi
if [ -t 0 ]; then
  read -rp "WebSocket port [${PORT}]: " _p || true
  PORT="${_p:-$PORT}"
fi
[[ "${PORT}" =~ ^[0-9]+$ ]] || die "Port must be a number."

echo
info "Domain : ${DOMAIN:-<none, plain ws://>}"
info "Port   : ${PORT}"
echo

# ── 1. base packages + Node 20 ────────────────────────────────────────
info "Installing base packages…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git ufw gnupg build-essential >/dev/null

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "${NODE_MAJOR}" ]; then
  info "Installing Node.js ${NODE_MAJOR}.x…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node -v) ready."

# ── 2. clone / update repo + install deps ─────────────────────────────
if [ -d "${INSTALL_DIR}/.git" ]; then
  info "Updating existing checkout…"
  git -C "${INSTALL_DIR}" fetch --quiet --tags origin
  git -C "${INSTALL_DIR}" reset --hard --quiet origin/main
else
  info "Cloning ${REPO_URL}…"
  rm -rf "${INSTALL_DIR}"
  git clone --quiet --depth 1 "${REPO_URL}" "${INSTALL_DIR}"
fi

info "Installing server dependencies (this can take a minute)…"
( cd "${SERVER_DIR}" && npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null 2>&1 )
[ -x "${SERVER_DIR}/node_modules/.bin/tsx" ] || die "tsx not found after install — dependency install failed."
ok "Server code + deps installed at ${SERVER_DIR}."

# ── 3. service user + data dir ────────────────────────────────────────
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
DATA_DIR="${DATA_DIR_DEFAULT}"
mkdir -p "${DATA_DIR}"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}"

# ── 4. config / secret ────────────────────────────────────────────────
mkdir -p "${CONFIG_DIR}"
if [ -f "${ENV_FILE}" ] && grep -q '^JWT_SECRET=' "${ENV_FILE}"; then
  info "Keeping existing JWT secret (tokens stay valid)."
  # refresh PORT / DATA_DIR lines, preserve the secret
  SECRET="$(grep '^JWT_SECRET=' "${ENV_FILE}" | head -1 | cut -d= -f2-)"
else
  SECRET="$(openssl rand -hex 48 2>/dev/null || head -c48 /dev/urandom | xxd -p | tr -d '\n')"
fi
cat > "${ENV_FILE}" <<EOF
# concord server configuration. Managed by the installer.
PORT=${PORT}
DATA_DIR=${DATA_DIR}
JWT_SECRET=${SECRET}
MIN_CLIENT_VERSION=2.0.0
EOF
chmod 600 "${ENV_FILE}"
ok "Config written to ${ENV_FILE} (JWT auth enabled)."

# ── 5. systemd service ────────────────────────────────────────────────
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=concord realtime server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${SERVER_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${SERVER_DIR}/node_modules/.bin/tsx ${SERVER_DIR}/src/index.ts
Restart=always
RestartSec=3
# hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --quiet "${SERVICE_NAME}" >/dev/null 2>&1 || true
systemctl restart "${SERVICE_NAME}"
sleep 2
systemctl is-active --quiet "${SERVICE_NAME}" || {
  warn "Service did not stay up. Recent logs:"
  journalctl -u "${SERVICE_NAME}" -n 30 --no-pager || true
  die "Server failed to start — see logs above."
}
ok "systemd service '${SERVICE_NAME}' is running."

# ── 6. TLS via Caddy, or open the port ────────────────────────────────
SERVER_URL=""
if [ -n "${DOMAIN}" ]; then
  if ! command -v caddy >/dev/null 2>&1; then
    info "Installing Caddy (automatic HTTPS)…"
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
  fi
  cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	reverse_proxy localhost:${PORT}
}
EOF
  systemctl restart caddy
  # Caddy needs 80/443 for ACME + HTTPS.
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  SERVER_URL="wss://${DOMAIN}"
  ok "Caddy reverse-proxy + automatic HTTPS configured for ${DOMAIN}."
else
  ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
  IP="$(curl -fsSL https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  SERVER_URL="ws://${IP}:${PORT}"
  warn "No domain → serving plain ws:// (no encryption). Fine for testing."
fi

# ── 7. management CLI ─────────────────────────────────────────────────
install -m 0755 "${SERVER_DIR}/scripts/manage.sh" "${MANAGE_BIN}"
ok "Management command installed: ${MANAGE_BIN}"

# ── 8. first token + summary ──────────────────────────────────────────
TOKEN="$( cd "${SERVER_DIR}" && JWT_SECRET="${SECRET}" node_modules/.bin/tsx src/gen-token.ts me 365d )"

echo
echo "${c_grn}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c_rst}"
echo "${c_grn} concord server is up.${c_rst}"
echo "${c_grn}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c_rst}"
echo
echo "  In the Collab plugin settings, set:"
echo
echo "    Server URL : ${c_cya}${SERVER_URL}${c_rst}"
echo "    Auth token : ${c_cya}${TOKEN}${c_rst}"
echo
echo "  Make a token for a friend:   ${c_yel}concord token <name>${c_rst}"
echo "  Open the management menu:    ${c_yel}concord${c_rst}"
echo "  Logs:                        ${c_yel}concord logs${c_rst}"
echo
if [ -n "${DOMAIN}" ]; then
  echo "  ${c_yel}DNS:${c_rst} ${DOMAIN} must already point (A/AAAA) to this server,"
  echo "       and ports 80+443 must be reachable, or HTTPS won't issue."
fi
echo
