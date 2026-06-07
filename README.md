# Concord

> **Concord — realtime collaboration & sync for Obsidian. Your notes, in harmony.**

> ⚠️ **АЛЬФА-ТЕСТИРОВАНИЕ — НЕ УСТАНАВЛИВАЙТЕ.**
> Плагин активно разрабатывается, ломается, переписывается и иногда повреждает данные. Подходит только разработчикам, готовым отлаживать чужой код в DevTools и держать резервные копии вольта. Стабильная установка для обычных пользователей появится позже.

---

## 🇷🇺 Русский

Self-hosted плагин для **realtime-совместного редактирования** в [Obsidian](https://obsidian.md). Open-source альтернатива Relay и Peerdraft. Живые курсоры, выделения, одновременная правка одной заметки — всё на вашей собственной инфраструктуре, без облачного аккаунта.

### Что умеет

- Видеть курсоры и выделения участников команды в режиме реального времени, пока они правят общую заметку.
- Сливать одновременные правки без конфликтов (под капотом CRDT — [Yjs](https://yjs.dev)).
- Синхронизировать структуру всего вольта: создание, удаление, переименование и перемещение файлов.
- Синхронизировать вложения: картинки, PDF, и другие бинарные файлы (до 25 MB).
- Real-time сов­мест­ное редактирование Obsidian Canvas (`.canvas`) — структурный CRDT по узлам.
- Атомарный синк Obsidian Bases (`.base`).
- Soft-delete с 30-дневной корзиной и восстановлением.
- Оффлайн-режим: правки накапливаются в IndexedDB и улетают на сервер при возврате связи.
- Опциональная JWT-авторизация на сервере.
- Запрет подключения старых клиентских версий (чтобы баги старых сборок не портили общие данные).

### Архитектура

```
Obsidian + плагин  <--WebSocket-->  Hocuspocus сервер  <-->  SQLite
```

- **Плагин:** TypeScript, своя привязка к CodeMirror 6 (не используем `y-codemirror.next` из-за несовместимости с переиспользованием editor view в Obsidian).
- **Сервер:** [Hocuspocus](https://tiptap.dev/docs/hocuspocus) — Yjs-бэкенд на Node.js.
- **Хранилище:** SQLite для состояния документов.
- **TLS:** опционально, через Caddy/nginx перед сервером.

### Структура репозитория

```
concord/
├── plugin/    # Obsidian-плагин (TypeScript)
├── server/    # Hocuspocus-сервер (TypeScript / Node.js)
├── docs/      # Документация для self-host и контрибьюторов
└── LICENSE    # AGPL-3.0
```

### Установка (когда выйдет стабильная версия)

Самый удобный путь — через [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Установить **BRAT** из Community plugins в Obsidian.
2. *Add Beta plugin* → вставить `https://github.com/leonestis/obsidian-concord`.
3. Задать **Server URL** в настройках Collab.

Авто-обновления при каждом новом теге. Подробности: [docs/install-for-users.md](docs/install-for-users.md).

### Self-hosting

Документация будет в [docs/](docs/) после стабильного релиза.

### Лицензия

[AGPL-3.0](LICENSE). Если запускаете изменённую версию и даёте к ней доступ через сеть — обязаны открыть свои исходники тем, кто этой версией пользуется.

---

## 🇬🇧 English

Self-hosted **realtime collaboration plugin** for [Obsidian](https://obsidian.md). Open-source alternative to Relay and Peerdraft. Live cursors, selections, and concurrent editing — all running on infrastructure you control. No cloud account.

> ⚠️ **Alpha — do not install.** Actively under development, breaking, being rewritten, occasionally corrupting data. Only suitable for developers willing to debug other people's code in DevTools and keep vault backups. A stable release for regular users will come later.

### What it does

- See teammates' cursors and selections in real time as they edit a shared note.
- Concurrent edits merge without conflicts (CRDT under the hood — [Yjs](https://yjs.dev)).
- Whole-vault structural sync: create, delete, rename, and move files all propagate.
- Attachment sync: images, PDFs, and any binary up to 25 MB.
- Real-time collaboration on Obsidian Canvas (`.canvas`) via a structural CRDT over nodes.
- Atomic sync for Obsidian Bases (`.base`).
- Soft-delete with a 30-day trash + restore.
- Offline-tolerant: edits queue in IndexedDB while disconnected and ship when the socket recovers.
- Optional JWT auth on the server.
- Client version gating — old versions with known bugs are refused at the WebSocket handshake so they can't pollute shared data.

### Architecture

```
Obsidian + plugin  <--WebSocket-->  Hocuspocus server  <-->  SQLite
```

- **Plugin:** TypeScript, custom CodeMirror 6 binding (we don't use `y-codemirror.next` because of incompatibilities with how Obsidian reuses a single editor view across files).
- **Server:** [Hocuspocus](https://tiptap.dev/docs/hocuspocus) — a Yjs collaboration backend on Node.js.
- **Storage:** SQLite for document state.
- **TLS:** optional, via Caddy/nginx in front of the server.

### Repository layout

```
concord/
├── plugin/    # Obsidian plugin (TypeScript)
├── server/    # Hocuspocus server (TypeScript / Node.js)
├── docs/      # Self-hosting and contributor docs
└── LICENSE    # AGPL-3.0
```

### Installing (once a stable release is out)

The friendliest route is via [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install the **BRAT** community plugin in Obsidian.
2. *Add Beta plugin* → paste `https://github.com/leonestis/obsidian-concord`.
3. Set **Server URL** in Collab's settings.

Auto-updates whenever a new tag ships. Step-by-step + the manual fallback: [docs/install-for-users.md](docs/install-for-users.md).

### Self-hosting

One command on a fresh Debian/Ubuntu VPS (as root):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/leonestis/obsidian-concord/main/server/scripts/install.sh)
```

It installs Node.js, the server, a systemd service and (if you give it a
domain) automatic HTTPS via Caddy — then prints the **Server URL + a
token** to paste into the plugin. Manage it afterwards with the
`concord` command (`status`, `logs`, `token <name>`, `update`,
`uninstall`). Full guide: [docs/self-hosting.md](docs/self-hosting.md).

### License

[AGPL-3.0](LICENSE). If you run a modified version of this software and let others use it over a network, you must make your modified source available to those users.
