# Self-hosting the obsidian-collab server

The server is a small Node.js (Hocuspocus + SQLite) process. The fastest
way to stand it up is the one-command installer for **Debian/Ubuntu**.

## One-command install

On a fresh VPS, as root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/leonestis/obsidian-collab/main/server/scripts/install.sh)
```

It will ask for:

- **Domain** — a hostname whose DNS A/AAAA record already points at this
  server. Give one and you get **automatic HTTPS** (`wss://`) via Caddy —
  this is what you want, and mobile Obsidian generally refuses an
  unencrypted `ws://`. Leave it blank to serve plain `ws://` by IP
  (testing only).
- **Port** — the WebSocket port (default `1234`). With a domain, clients
  connect on `443`; the port is just the internal one Caddy proxies to.

When it finishes it prints the **Server URL** and a ready-to-use **auth
token** — paste both into the Collab plugin's settings.

Non-interactive (e.g. in your own provisioning):

```bash
DOMAIN=collab.example.com PORT=1234 \
  bash <(curl -fsSL https://raw.githubusercontent.com/leonestis/obsidian-collab/main/server/scripts/install.sh)
```

### What it sets up

| Thing | Location |
|---|---|
| Code | `/opt/obsidian-collab` |
| Config + JWT secret | `/etc/obsidian-collab/env` (root-only) |
| Data (SQLite + blobs) | `/var/lib/obsidian-collab` |
| Service | systemd unit `obsidian-collab` (auto-start, auto-restart) |
| Runs as | dedicated `obsidian-collab` system user |
| HTTPS | Caddy (if a domain was given) |

## Managing the server

The installer adds an `obsidian-collab` command. Run it with no arguments
for a menu, or use subcommands (most need `sudo`):

```bash
sudo obsidian-collab               # interactive menu
sudo obsidian-collab status
sudo obsidian-collab restart
sudo obsidian-collab logs          # live logs (Ctrl-C to exit)
sudo obsidian-collab token alex    # mint a token for a friend (365d)
sudo obsidian-collab token bob 90d # custom expiry
sudo obsidian-collab url           # show the Server URL to paste
sudo obsidian-collab update        # pull latest + restart
sudo obsidian-collab uninstall     # remove (asks whether to keep data)
```

### Adding a friend

```bash
sudo obsidian-collab token theirname
```

Send them that token plus the Server URL. They paste both into their
Collab plugin settings. That's it — same vault, realtime.

## Notes

- **Authentication is on by default.** A random `JWT_SECRET` is generated
  at install and stored in `/etc/obsidian-collab/env` (never committed,
  never printed). Only tokens signed with it can connect. Re-running the
  installer keeps the existing secret so old tokens stay valid.
- **Updating** keeps your data and secret; it only refreshes code and
  restarts the service.
- **TLS without a domain:** if you can't use a domain, put your own
  reverse proxy / tunnel in front and point the plugin at the `wss://`
  URL it exposes. Plain `ws://` works on desktop but often not on mobile.
- **AGPL-3.0:** if you run a modified server and let others use it over
  the network, you must offer them your modified source.
- **Requirements:** a Debian/Ubuntu host with root. The installer pulls
  Node.js 20, git, ufw, Caddy (when a domain is given) and build tools.
