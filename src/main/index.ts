import { app, BrowserWindow, shell } from "electron";
import * as path from "path";
import {
  isSetupComplete,
  ensureDirectories,
  generateOpenClawConfig,
  installTlonPlugin,
  getConfig,
} from "./config";
import { TrayManager } from "./tray";
import { VereManager } from "./processes/vere";
import { OpenClawManager } from "./processes/openclaw";
import { registerIpcHandlers } from "./ipc";

// Keep references to prevent GC
let setupWindow: BrowserWindow | null = null;
const tray = new TrayManager();
const vere = new VereManager();
const openclaw = new OpenClawManager();
let isQuitting = false;

function providerLabel(provider: string): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "openrouter") return "OpenRouter";
  return "MiniMax";
}

function createSetupWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 580,
    height: 680,
    resizable: false,
    titleBarStyle: "hiddenInset",
    vibrancy: "under-window",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  win.on("closed", () => {
    setupWindow = null;
  });

  return win;
}

function setupTray(): void {
  tray.create({
    onToggle: async () => {
      if (vere.getState() === "running" || openclaw.getState() === "running") {
        await stopServices();
      } else {
        await startServices();
      }
    },
    onSettings: () => {
      if (setupWindow) {
        setupWindow.focus();
      } else {
        setupWindow = createSetupWindow();
      }
    },
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });

  // Wire up state changes to tray
  vere.on("stateChange", (state) => tray.updateVereState(state));
  openclaw.on("stateChange", (state) => tray.updateOpenClawState(state));
  openclaw.on("authRequired", ({ dashboardUrl }) => {
    console.warn("OpenClaw reported missing dashboard token; opening tokenized dashboard URL.");
    void shell.openExternal(dashboardUrl);
  });
}

async function startServices(): Promise<void> {
  try {
    const config = getConfig();
    if (!config.apiKey.trim()) {
      throw new Error(
        `${providerLabel(config.apiProvider)} API key is required. Open Settings and add it in Step 2.`
      );
    }

    // Start vere first
    if (vere.isPierCreated()) {
      await vere.start();
      // Always refresh +code before launching OpenClaw so auth uses current credentials.
      await vere.refreshCode();
    } else {
      throw new Error("Pier not found. Complete moon setup before starting services.");
    }
    // Ensure external tlon plugin is installed and dependencies are present.
    installTlonPlugin();
    // Keep OpenClaw channel URL aligned with current vere config.
    generateOpenClawConfig();
    // Then start OpenClaw
    await openclaw.start();
  } catch (err: any) {
    console.error("Failed to start services:", err.message);
  }
}

async function stopServices(): Promise<void> {
  try {
    await openclaw.stop();
    await vere.stop();
  } catch (err: any) {
    console.error("Failed to stop services:", err.message);
  }
}

// App lifecycle
app.on("ready", () => {
  ensureDirectories();
  registerIpcHandlers(vere, openclaw);

  if (isSetupComplete()) {
    // Normal startup: tray + boot services
    setupTray();
    startServices();
  } else {
    // First run: show setup wizard
    setupTray();
    setupWindow = createSetupWindow();
  }
});

app.on("window-all-closed", () => {
  // Don't quit - tray app stays running
});

app.on("before-quit", async (event) => {
  if (!isQuitting) return;

  // Prevent default to handle async shutdown
  event.preventDefault();

  console.log("Shutting down services...");
  await stopServices();
  console.log("Services stopped. Exiting.");

  // Now actually quit
  isQuitting = false;
  app.exit(0);
});

// macOS: re-open setup window when clicking dock icon (if visible)
app.on("activate", () => {
  if (!setupWindow && !isSetupComplete()) {
    setupWindow = createSetupWindow();
  }
});
