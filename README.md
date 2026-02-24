# TlonBot Electron App

## Context

The goal is to create a macOS menubar/tray Electron app that bundles **OpenClaw** (AI assistant gateway), the **Urbit vere runtime** (for running a local moon), and the **Tlon plugin** (connecting OpenClaw to Urbit messaging). Today, setting these up requires multiple manual steps: generating moon credentials on Horizon, downloading vere, booting the moon, running `+code`, installing OpenClaw, cloning the Tlon plugin, and writing config files. This app automates all of that into a download-and-run experience.

## Architecture Overview

```
┌─────────────────────────────────────────┐
│           Electron Main Process         │
│                                         │
│  ┌─────────┐  ┌─────────┐  ┌────────┐  │
│  │  Tray   │  │  Setup  │  │ Config │  │
│  │ Manager │  │ Wizard  │  │ Store  │  │
│  └─────────┘  └─────────┘  └────────┘  │
│                                         │
│  ┌──────────────────────────────────┐   │
│  │       Process Manager            │   │
│  │  ┌────────────┐ ┌────────────┐   │   │
│  │  │   vere     │ │  OpenClaw  │   │   │
│  │  │ (child     │ │  gateway   │   │   │
│  │  │  process)  │ │ (child     │   │   │
│  │  │            │ │  process)  │   │   │
│  │  └────────────┘ └────────────┘   │   │
│  └──────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

**What's bundled in the app:**

- Electron runtime (includes Node.js)
- OpenClaw npm package (in node_modules)
- openclaw-tlon plugin (in app resources, with deps)

**Downloaded on first launch:**

- vere binary (~50MB, architecture-detected: Apple Silicon or Intel)

**Generated during setup:**

- Moon pier directory (from user-provided credentials)
- `openclaw.json` config
- Gateway auth token

## Tech Stack

- **Electron** 35+ with electron-builder for packaging
- **TypeScript** throughout
- **Vanilla HTML/CSS** for setup wizard (keep it simple, no React needed)
- **Node.js child_process** for managing vere and OpenClaw

## Data Directories

All app data lives under `~/Library/Application Support/TlonBot/`:

```
~/Library/Application Support/TlonBot/
├── bin/
│   └── urbit              # Downloaded vere binary
├── pier/                  # Urbit moon pier (created on first boot)
├── openclaw/
│   ├── openclaw.json      # Generated config
│   └── workspace/         # OpenClaw workspace (prompts, etc.)
├── extensions/
│   └── tlon/              # openclaw-tlon plugin (copied from app bundle)
└── logs/
    ├── vere.log
    └── openclaw.log
```

## Project Structure

```
tlonbot-electron/
├── package.json
├── tsconfig.json
├── electron-builder.yml
├── src/
│   ├── main/
│   │   ├── index.ts              # Entry point, app lifecycle
│   │   ├── tray.ts               # Tray icon, menu, status
│   │   ├── config.ts             # Config generation & persistence
│   │   ├── downloader.ts         # vere binary download with progress
│   │   ├── processes/
│   │   │   ├── vere.ts           # Spawn/manage vere, parse output, extract +code
│   │   │   └── openclaw.ts       # Spawn/manage openclaw gateway
│   │   └── ipc.ts                # IPC handlers for renderer communication
│   ├── renderer/
│   │   ├── index.html            # Setup wizard shell
│   │   ├── setup.ts              # Setup wizard logic
│   │   └── styles.css            # Minimal styling
│   └── preload/
│       └── index.ts              # Secure IPC bridge
├── assets/
│   ├── tray-iconTemplate.png     # 22x22 menubar icon
│   └── tray-iconTemplate@2x.png  # Retina menubar icon
├── resources/
│   └── tlon-plugin/              # Bundled openclaw-tlon plugin (git submodule)
└── scripts/
    ├── prepare-plugin.sh         # Build script to install plugin deps
    ├── after-pack.js             # electron-builder afterPack hook
    └── generate-icons.js         # Generate placeholder tray icons
```

## Implementation Steps

### Step 1: Project Scaffolding

Initialize Electron project with TypeScript, electron-builder, and development tooling.

**Files:** `package.json`, `tsconfig.json`, `electron-builder.yml`

Key dependencies:

- `electron` (dev)
- `electron-builder` (dev)
- `typescript` (dev)
- `openclaw` (bundled AI gateway)

electron-builder config:

- Target: `dmg` for macOS
- `asar: true` (pack app code)
- `extraResources`: include `resources/tlon-plugin` directory
- `mac.category`: `public.app-category.utilities`
- No dock icon by default (`LSUIElement: true` in Info.plist)

### Step 2: Main Process Entry (`src/main/index.ts`)

App lifecycle:

1. On `app.ready`: Check if first run (no config exists)
2. **First run**: Show setup wizard window
3. **Subsequent runs**: Start tray, boot vere, then start OpenClaw
4. On `app.before-quit`: Gracefully shut down OpenClaw, then vere
5. On `window-all-closed`: Don't quit (tray app stays running)

### Step 3: Setup Wizard (`src/renderer/`)

A single-window, multi-step wizard shown on first launch:

**Step 1 - Welcome**: Brief explanation of what the app does.

**Step 2 - Moon Credentials**:

- Instructions with numbered steps + link to `https://horizon.tlon.network`
- Guide: log in, go to `/apps/webterm`, run `|moon`, copy moon ID + key string
- Input fields: Moon ID (`~mipbur-moswep-sampel-palnet`), Key string (long hex)
- Input field: Owner ship (`~sampel-palnet`) - your main Tlon identity

**Step 3 - API Key**:

- Radio selection: Anthropic / OpenRouter / MiniMax (free default)
- API key input field (conditional on selection)
- Model selection dropdown

**Step 4 - Download & Boot**:

- Auto-detect architecture (Apple Silicon vs Intel)
- Download vere with progress bar from `https://urbit.org/install/macos-{arch}/latest`
- Make binary executable
- Boot moon: spawn `./urbit -w moon-id -G keystring -p 8080` in pier directory
- Monitor stdout for boot completion
- Send `+code` to stdin, capture access code from stdout
- Show status updates throughout

**Step 5 - Done**:

- Generate `openclaw.json` with all gathered config
- Copy and install tlon plugin from app resources
- Start OpenClaw gateway
- Show success message with gateway URL
- Transition to tray mode

### Step 4: Vere Process Manager (`src/main/processes/vere.ts`)

```typescript
// Key responsibilities:
// - Download vere binary (first launch)
// - Spawn vere as child process
// - First boot: `./urbit -w <moon> -G <key> -p <port>` (creates pier)
// - Subsequent boots: `./urbit <pier-path> -p <port>`
// - Parse stdout for HTTP port and boot status
// - Extract +code by writing to stdin after boot
// - Handle crashes with auto-restart (with backoff)
// - Graceful shutdown via SIGTERM
```

Stdout parsing patterns:

- Boot complete: look for `http: web interface live on http://localhost:XXXX`
- `+code` response: look for `~.` followed by the code pattern

### Step 5: OpenClaw Process Manager (`src/main/processes/openclaw.ts`)

```typescript
// Key responsibilities:
// - Resolve openclaw binary from node_modules/.bin/openclaw
// - Spawn: `openclaw gateway --port 18789 --bind lan --token <token>`
// - Set OPENCLAW_HOME env var to app data dir
// - Wait for gateway to be healthy (poll /health endpoint)
// - Handle crashes with auto-restart
// - Graceful shutdown via SIGTERM
```

The OpenClaw process depends on vere being ready (moon booted + code extracted), so it starts sequentially after vere.

### Step 6: Config Generation (`src/main/config.ts`)

Generate `openclaw.json` modeled on the tlonbot repo's config:

```json
{
  "agents": {
    "defaults": {
      "workspace": "<app-data>/openclaw/workspace",
      "model": { "primary": "<user-selected-model>" }
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local",
    "auth": { "token": "<generated-uuid>" }
  },
  "plugins": {
    "load": { "paths": ["<app-data>/extensions/tlon"] },
    "entries": { "tlon": { "enabled": true } }
  },
  "channels": {
    "tlon": {
      "enabled": true,
      "ship": "<moon-id>",
      "code": "<extracted-code>",
      "url": "http://localhost:<vere-port>",
      "ownerShip": "<owner-ship>",
      "dmAllowlist": ["<owner-ship>"],
      "allowPrivateNetwork": true,
      "autoDiscoverChannels": true
    }
  },
  "tools": {
    "allow": ["web_fetch", "message", "web_search", "read", "tlon"],
    "deny": ["bash", "canvas", "exec", "gateway", "nodes", "process"],
    "elevated": { "enabled": false }
  },
  "session": { "dmScope": "per-channel-peer" }
}
```

### Step 7: Tray Manager (`src/main/tray.ts`)

macOS menubar tray with status indicator:

```
Menu items:
─────────────────────────
 TlonBot                  (bold, app name)
─────────────────────────
 Status: Running          (or Starting.../Stopped/Error)
 Urbit: ● Online          (green dot)
 OpenClaw: ● Online       (green dot)
─────────────────────────
 Open Dashboard            → opens browser to gateway URL
─────────────────────────
 Start / Stop              → toggle processes
 Settings...               → opens setup wizard for editing
 View Logs                 → opens log files in Console.app
─────────────────────────
 Quit TlonBot
```

Tray icon states:

- Normal: standard icon
- Starting: animated/pulsing
- Error: icon with red indicator

### Step 8: Build & Packaging

`electron-builder.yml`:

- Build tlon-plugin dependencies during `afterPack` hook
- Universal binary support (both arm64 and x64)
- Code sign with Apple Developer ID (if available, otherwise unsigned for dev)
- DMG installer with drag-to-Applications layout

Build script (`scripts/prepare-plugin.sh`):

- Copy `resources/tlon-plugin` to staging area
- Run `npm install --production` in the plugin directory
- This runs as part of the electron-builder build process

### Step 9: Logging

Write vere and OpenClaw stdout/stderr to rotating log files in `<app-data>/logs/`. The "View Logs" tray menu item opens the log directory in Finder or the current log in Console.app.

## Startup Sequence (after first-run setup)

```
1. App launches (no dock icon, tray only)
2. Read config from electron-store
3. Spawn vere child process with pier path
4. Wait for vere HTTP server to come online (parse stdout)
5. Spawn OpenClaw gateway child process
6. Wait for gateway health check to pass
7. Update tray: "Status: Running"
8. User interacts via Tlon Messenger → messages reach moon → OpenClaw processes them
```

## Shutdown Sequence

```
1. User clicks "Quit TlonBot" or Cmd+Q
2. Send SIGTERM to OpenClaw process, wait up to 5s
3. Send SIGTERM to vere process, wait up to 10s (pier needs clean shutdown)
4. If processes don't exit, SIGKILL
5. App exits
```

## Key External References

- **vere download URLs**: `https://urbit.org/install/macos-aarch64/latest` (Apple Silicon), `https://urbit.org/install/macos-x86_64/latest` (Intel)
- **OpenClaw npm package**: `openclaw` (global install or local dep)
- **Tlon plugin repo**: `https://github.com/tloncorp/openclaw-tlon`
- **tlonbot config repo**: `https://github.com/tloncorp/tlonbot` (for openclaw.json template and prompts)
- **Selfhost setup script**: `tlonbot/selfhost/tlon-openclaw.sh` (reference implementation)

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development
npm run dev

# Package as DMG
npm run package
```

### Setting up the Tlon Plugin

Clone the openclaw-tlon plugin into the resources directory:

```bash
git clone https://github.com/tloncorp/openclaw-tlon resources/tlon-plugin
npm run prepare-plugin
```

## Verification

1. **Build**: `npm run build && npm run package` produces a `.dmg`
2. **First launch**: Setup wizard appears, all steps complete
3. **vere boots**: Moon comes online, `+code` is extracted
4. **OpenClaw starts**: Gateway responds on `http://localhost:18789`
5. **Tray works**: Icon visible, menu items functional, "Open Dashboard" opens browser
6. **Messaging works**: DM the moon in Tlon Messenger, get a response
7. **Restart**: Quit and relaunch - skips setup, goes straight to tray, boots services
8. **Clean shutdown**: Quit from tray, both processes terminate cleanly
