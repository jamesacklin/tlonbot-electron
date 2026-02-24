import { ipcMain, BrowserWindow } from "electron";
import {
  getConfig,
  setConfig,
  generateGatewayToken,
  generateOpenClawConfig,
  installTlonPlugin,
  ensureDirectories,
} from "./config";
import { downloadVere, getArchitectureLabel } from "./downloader";
import { VereManager } from "./processes/vere";
import { OpenClawManager } from "./processes/openclaw";

export function registerIpcHandlers(
  vere: VereManager,
  openclaw: OpenClawManager
): void {
  ipcMain.handle("get-architecture", () => {
    return getArchitectureLabel();
  });

  ipcMain.handle("download-vere", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      await downloadVere((percent) => {
        win?.webContents.send("download-progress", percent);
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("boot-moon", async (event, moonId: string, moonKey: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);

    const logCleanup = (message: string) => {
      win?.webContents.send("boot-log", message);
    };
    vere.on("log", logCleanup);

    try {
      win?.webContents.send("setup-status", "Stopping existing services...");
      await openclaw.stop();
      await vere.stop();

      win?.webContents.send("setup-status", "Booting moon...");
      const code = await vere.boot(moonId, moonKey);
      vere.removeListener("log", logCleanup);
      return { success: true, code };
    } catch (err: any) {
      vere.removeListener("log", logCleanup);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("save-config", (_event, config: Record<string, unknown>) => {
    setConfig(config as any);
    return { success: true };
  });

  ipcMain.handle("finish-setup", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);

    try {
      ensureDirectories();

      // Generate gateway token
      win?.webContents.send("setup-status", "Generating gateway token...");
      generateGatewayToken();

      // Generate openclaw.json config
      win?.webContents.send("setup-status", "Writing OpenClaw config...");
      generateOpenClawConfig();

      // Install tlon plugin from app bundle
      win?.webContents.send("setup-status", "Installing Tlon plugin...");
      installTlonPlugin();

      // Start OpenClaw gateway
      win?.webContents.send("setup-status", "Starting OpenClaw gateway...");
      await openclaw.start();

      // Mark setup as complete
      setConfig({ setupComplete: true });

      win?.webContents.send("setup-status", "Setup complete!");
      return { success: true, gatewayUrl: openclaw.getGatewayUrl() };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("get-config", () => {
    return getConfig();
  });

  ipcMain.handle("get-status", () => {
    return {
      vere: vere.getState(),
      openclaw: openclaw.getState(),
      gatewayUrl: openclaw.getGatewayUrl(),
    };
  });
}
