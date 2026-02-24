import { Tray, Menu, nativeImage, shell, app } from "electron";
import * as path from "path";
import { VereState } from "./processes/vere";
import { OpenClawState } from "./processes/openclaw";
import { getLogsPath, getDashboardUrl } from "./config";

export class TrayManager {
  private tray: Tray | null = null;
  private vereState: VereState = "stopped";
  private openclawState: OpenClawState = "stopped";
  private onToggle: (() => void) | null = null;
  private onSettings: (() => void) | null = null;
  private onQuit: (() => void) | null = null;

  create(callbacks: {
    onToggle: () => void;
    onSettings: () => void;
    onQuit: () => void;
  }): void {
    this.onToggle = callbacks.onToggle;
    this.onSettings = callbacks.onSettings;
    this.onQuit = callbacks.onQuit;

    // Create a simple tray icon - 22x22 template image for macOS
    const iconPath = this.getIconPath();
    let icon: Electron.NativeImage;

    try {
      icon = nativeImage.createFromPath(iconPath);
      icon.setTemplateImage(true);
    } catch {
      // Fallback: create a simple 22x22 icon programmatically
      icon = nativeImage.createEmpty();
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip("TlonBot");
    this.updateMenu();
  }

  private getIconPath(): string {
    // In dev, look in assets/ relative to project root
    const devPath = path.join(__dirname, "..", "..", "assets", "tray-iconTemplate.png");
    // In production, look in resources
    const prodPath = path.join(process.resourcesPath || "", "assets", "tray-iconTemplate.png");

    const fs = require("fs");
    if (fs.existsSync(devPath)) return devPath;
    if (fs.existsSync(prodPath)) return prodPath;
    return devPath; // will use fallback empty icon
  }

  updateVereState(state: VereState): void {
    this.vereState = state;
    this.updateMenu();
  }

  updateOpenClawState(state: OpenClawState): void {
    this.openclawState = state;
    this.updateMenu();
  }

  private getOverallStatus(): string {
    if (this.vereState === "running" && this.openclawState === "running") {
      return "Running";
    }
    if (this.vereState === "error" || this.openclawState === "error") {
      return "Error";
    }
    if (this.vereState === "booting" || this.openclawState === "starting") {
      return "Starting...";
    }
    return "Stopped";
  }

  private stateIndicator(state: string): string {
    switch (state) {
      case "running":
        return "● Online";
      case "booting":
      case "starting":
        return "◐ Starting";
      case "error":
        return "● Error";
      default:
        return "○ Offline";
    }
  }

  private isRunning(): boolean {
    return this.vereState === "running" || this.openclawState === "running";
  }

  private updateMenu(): void {
    if (!this.tray) return;

    const dashboardUrl = getDashboardUrl(true);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: "TlonBot",
        enabled: false,
      },
      { type: "separator" },
      {
        label: `Status: ${this.getOverallStatus()}`,
        enabled: false,
      },
      {
        label: `  Urbit: ${this.stateIndicator(this.vereState)}`,
        enabled: false,
      },
      {
        label: `  OpenClaw: ${this.stateIndicator(this.openclawState)}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Open Dashboard",
        enabled: this.openclawState === "running",
        click: () => {
          shell.openExternal(dashboardUrl);
        },
      },
      { type: "separator" },
      {
        label: this.isRunning() ? "Stop" : "Start",
        click: () => this.onToggle?.(),
      },
      {
        label: "Settings...",
        click: () => this.onSettings?.(),
      },
      {
        label: "View Logs",
        click: () => {
          shell.openPath(getLogsPath());
        },
      },
      { type: "separator" },
      {
        label: "Quit TlonBot",
        click: () => this.onQuit?.(),
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
