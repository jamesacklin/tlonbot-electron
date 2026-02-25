# Tlonbot Electron App

Tlonbot is a macOS menu bar app that runs a local Urbit moon (`vere`), OpenClaw Gateway, and the Tlon OpenClaw plugin. It handles first-run setup and then keeps both services running from the tray.

## Current App Architecture

### High-level

```text
Electron Main Process
├── App lifecycle + orchestration (src/main/index.ts)
├── Tray UI and controls (src/main/tray.ts)
├── IPC handlers for setup/status (src/main/ipc.ts)
├── Config + filesystem + plugin install (src/main/config.ts)
├── Vere download/validation (src/main/downloader.ts)
├── Vere child process manager (src/main/processes/vere.ts)
└── OpenClaw child process manager (src/main/processes/openclaw.ts)

Renderer Process
└── Setup wizard UI (src/renderer/index.html, src/renderer/setup.ts)

Preload
└── Secure bridge for renderer -> ipcMain calls (src/preload/index.ts)
```

### Runtime responsibilities

- `index.ts`
  - Creates tray at startup.
  - Shows setup window when `setupComplete` is false.
  - On normal launches, starts `vere` first, refreshes moon `+code`, regenerates OpenClaw config, then starts OpenClaw.
  - On quit, shuts down OpenClaw then `vere`.
- `VereManager`
  - Boots new moons with `urbit -t -w <moon> -G <key> -c <pier> --http-port <port>`.
  - Starts existing piers with `urbit -t --http-port <port> <pier>`.
  - Detects readiness from `http: web interface live on http://localhost:<port>`.
  - Extracts `+code` via `conn.sock` using `urbit eval` khan calls.
  - Writes logs to `logs/vere.log` and restarts with exponential backoff (up to 5 attempts).
- `OpenClawManager`
  - Starts gateway with `openclaw gateway --port <gatewayPort> --bind lan --token <token>`.
  - Sets `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, and `OPENCLAW_CONFIG_PATH`.
  - Waits for `/health` before marking running.
  - Writes logs to `logs/openclaw.log` and restarts with exponential backoff (up to 5 attempts).
- `config.ts`
  - Persists app config in `tlonbot-config.json`.
  - Generates `openclaw/openclaw.json` (gateway auth, plugin loading, Tlon channel settings, tool allow/deny, model/provider config).
  - Installs/copies bundled `resources/tlon-plugin` into user data `extensions/tlon` and installs plugin dependencies when needed.

## Setup Flow (Current Implementation)

### First launch (setup wizard)

1. User enters:
   - owner ship (`~...`)
   - moon name (`~...`)
   - moon key
   - AI provider + model (+ API key where needed)
2. App downloads the correct macOS `vere` binary from `https://urbit.org/install/macos-{aarch64|x86_64}/latest`.
3. App validates payload type, extracts gzip/tar when needed, marks executable, and verifies/ad-hoc-signs code signature.
4. App boots the moon, waits for Eyre, and extracts fresh `+code`.
5. App finalizes setup:
   - generates gateway token
   - installs Tlon plugin
   - refreshes `+code` again
   - writes OpenClaw config
   - starts OpenClaw gateway
   - marks `setupComplete: true`

### Subsequent launches

1. Tray starts.
2. If setup is complete and a pier exists, `vere` starts.
3. `+code` is refreshed.
4. Plugin install/config are reconciled.
5. OpenClaw starts and health-checks.

## Persistent Data Layout

On macOS this lives under `~/Library/Application Support/tlonbot/`:

```text
tlonbot/
├── tlonbot-config.json
├── bin/
│   └── urbit
├── piers/
│   └── <moon-name>/
├── openclaw/
│   ├── openclaw.json
│   ├── state/
│   └── workspace/
├── extensions/
│   └── tlon/
└── logs/
    ├── vere.log
    └── openclaw.log
```

Notes:

- Legacy fallbacks are supported for older installs (`pier/` and `openclaw/.openclaw/openclaw.json`).
- Default ports are `vere: 8080` and `gateway: 18789`.

## Project Structure

```text
tlonbot-electron/
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── ipc.ts
│   │   ├── config.ts
│   │   ├── downloader.ts
│   │   ├── tray.ts
│   │   └── processes/
│   │       ├── vere.ts
│   │       └── openclaw.ts
│   ├── preload/
│   │   └── index.ts
│   └── renderer/
│       ├── index.html
│       ├── setup.ts
│       └── styles.css
├── resources/
│   └── tlon-plugin/      # git submodule
├── scripts/
│   ├── prepare-plugin.sh
│   ├── after-pack.js
│   └── generate-icons.js
├── electron-builder.yml
└── package.json
```

## Local Development Setup

### Prerequisites

- macOS (downloader and runtime management are macOS-specific)
- Node.js + npm
- `git` with submodule support
- System `tar` and `codesign` available in PATH

### Install

```bash
git clone <repo-url>
cd tlonbot-electron
git submodule update --init --recursive
npm install
npm run prepare-plugin
```

### Run

```bash
npm run dev
```

Useful scripts:

- `npm run build`: compile TypeScript and copy renderer assets to `dist/`
- `npm run start`: build and run Electron
- `npm run dev`: current dev entry (build + run)
- `npm run package`: build macOS DMG via electron-builder

## Packaging

`electron-builder.yml` currently builds:

- macOS DMG for `arm64` and `x64`
- tray-style app (`LSUIElement: true`, no Dock icon)
- `asar: true`
- bundled `resources/tlon-plugin` via `extraResources`
- `afterPack` hook that runs `npm install --production` inside packaged `tlon-plugin`
