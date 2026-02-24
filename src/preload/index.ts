import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("tlonbot", {
  // Setup wizard actions
  getArchitecture: () => ipcRenderer.invoke("get-architecture"),
  downloadVere: () => ipcRenderer.invoke("download-vere"),
  bootMoon: (moonId: string, moonKey: string) =>
    ipcRenderer.invoke("boot-moon", moonId, moonKey),
  saveConfig: (config: Record<string, unknown>) =>
    ipcRenderer.invoke("save-config", config),
  finishSetup: () => ipcRenderer.invoke("finish-setup"),

  // Status queries
  getConfig: () => ipcRenderer.invoke("get-config"),
  getStatus: () => ipcRenderer.invoke("get-status"),

  // Event listeners
  onProgress: (callback: (percent: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, percent: number) =>
      callback(percent);
    ipcRenderer.on("download-progress", listener);
    return () => ipcRenderer.removeListener("download-progress", listener);
  },
  onStatus: (callback: (status: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: string) =>
      callback(status);
    ipcRenderer.on("setup-status", listener);
    return () => ipcRenderer.removeListener("setup-status", listener);
  },
  onBootLog: (callback: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) =>
      callback(message);
    ipcRenderer.on("boot-log", listener);
    return () => ipcRenderer.removeListener("boot-log", listener);
  },
});
