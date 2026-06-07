# Installing concord in your vault

You have two choices. **BRAT** is the painless one — set up once and your plugin auto-updates whenever a new release ships. The manual route is for one-off testing.

## Option A — BRAT (recommended)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) is a community plugin made specifically for installing other plugins straight from GitHub repositories. After a five-minute setup you'll get update notifications the moment we tag a new version.

1. In Obsidian, open **Settings → Community plugins** and turn community plugins on if you haven't.
2. Click **Browse**, search for **BRAT** (full name: *Obsidian42 - BRAT*), install it, enable it.
3. Open BRAT's settings (left sidebar of the plugins screen) → **Add Beta plugin**.
4. Paste the repository URL:

   ```
   https://github.com/leonestis/obsidian-concord
   ```

5. Tick *"Enable after installing"* and click **Add Plugin**. BRAT downloads the latest release and turns the plugin on.
6. Go to **Settings → Community plugins → Installed → Collab (self-hosted realtime)**, click the gear icon, and fill in **Server URL** with the address of your Hocuspocus server, for example:

   ```
   ws://your-server.example.com:1234
   ```

   Ask the operator running your server for the exact URL and the JWT auth token (paste it into **Auth token** — required when the server runs in authenticated mode). Also set your **Display name** so other people see who you are when collaborating.

That's it. When we ship a new version BRAT will install it automatically the next time you open Obsidian.

### When does BRAT update?

BRAT checks for updates when Obsidian starts, and on demand via the command palette → **BRAT: Check for updates to all beta plugins**. You can also enable *Auto-update on startup* in BRAT's settings.

## Option B — Manual

If you don't want another plugin, install once by hand:

1. Open the latest release: [Releases page](https://github.com/leonestis/obsidian-concord/releases/latest).
2. Download `main.js`, `manifest.json`, and `styles.css`.
3. Open your vault folder in Finder / Files / Explorer. You may need to enable hidden files.
4. Navigate into `.obsidian/plugins/` (create the `plugins` folder if it's missing).
5. Create a new folder named exactly **`concord`** and drop the three downloaded files inside it.
6. In Obsidian, **Settings → Community plugins**, hit the refresh icon, find *Collab (self-hosted realtime)*, enable it.
7. Configure **Server URL** and **Display name** as in Option A step 6.

To update later: download the three new files from the latest release and overwrite the old ones.

## Troubleshooting

- **Status bar shows 🔴 collab offline.** Open the dev console (`Ctrl/Cmd + Shift + I` → *Console*) and look for `[collab]` lines. The most common cause is a typo in the Server URL; it must start with `ws://` (or `wss://` once TLS is set up).
- **Plugin doesn't appear after BRAT install.** Open the command palette → **Reload app without saving**. BRAT-installed plugins sometimes need that nudge.
- **Friend's edits don't appear.** Run the command **"Collab: Show connection status (diagnostics)"** — it lists every active room and how many peers are connected to each.

## Releasing a new version (maintainers)

This is the loop on our side:

1. Make changes, bump `plugin/manifest.json` + `plugin/package.json` to the new version (e.g. `0.5.1`).
2. Commit and push.
3. Tag and push the tag: `git tag v0.5.1 && git push --tags`.
4. The `Release plugin` GitHub Action builds the plugin and publishes a Release with `main.js`, `manifest.json`, and `styles.css`.
5. BRAT picks it up on every user's next launch.
