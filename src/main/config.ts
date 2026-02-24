import { app } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";

export interface TlonBotConfig {
  moonId: string;
  moonKey: string;
  ownerShip: string;
  moonCode: string;
  apiProvider: "anthropic" | "openrouter" | "minimax";
  apiKey: string;
  model: string;
  gatewayToken: string;
  verePort: number;
  gatewayPort: number;
  setupComplete: boolean;
}

const defaults: TlonBotConfig = {
  moonId: "",
  moonKey: "",
  ownerShip: "",
  moonCode: "",
  apiProvider: "minimax",
  apiKey: "",
  model: "minimax/MiniMax-M1",
  gatewayToken: "",
  verePort: 8080,
  gatewayPort: 18789,
  setupComplete: false,
};

function getConfigFilePath(): string {
  return path.join(app.getPath("userData"), "tlonbot-config.json");
}

function readStore(): TlonBotConfig {
  const filePath = getConfigFilePath();
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    return { ...defaults, ...JSON.parse(data) };
  } catch {
    return { ...defaults };
  }
}

function writeStore(config: TlonBotConfig): void {
  const filePath = getConfigFilePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

export function getConfig(): TlonBotConfig {
  return readStore();
}

export function setConfig(partial: Partial<TlonBotConfig>): void {
  const current = readStore();
  const updated = { ...current, ...partial };
  writeStore(updated);
}

export function isSetupComplete(): boolean {
  return readStore().setupComplete;
}

export function getAppDataPath(): string {
  return app.getPath("userData");
}

export function getBinPath(): string {
  return path.join(getAppDataPath(), "bin");
}

export function getVereBinaryPath(): string {
  return path.join(getBinPath(), "urbit");
}

export function getPierPath(): string {
  return path.join(getAppDataPath(), "pier");
}

export function getOpenClawHome(): string {
  return path.join(getAppDataPath(), "openclaw");
}

export function getOpenClawConfigPath(): string {
  return path.join(getOpenClawHome(), "openclaw.json");
}

export function getWorkspacePath(): string {
  return path.join(getOpenClawHome(), "workspace");
}

export function getExtensionsPath(): string {
  return path.join(getAppDataPath(), "extensions");
}

export function getTlonPluginPath(): string {
  return path.join(getExtensionsPath(), "tlon");
}

export function getLogsPath(): string {
  return path.join(getAppDataPath(), "logs");
}

export function ensureDirectories(): void {
  const dirs = [
    getBinPath(),
    getPierPath(),
    getOpenClawHome(),
    getWorkspacePath(),
    getExtensionsPath(),
    getLogsPath(),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function generateGatewayToken(): string {
  const token = crypto.randomUUID();
  setConfig({ gatewayToken: token });
  return token;
}

export function generateOpenClawConfig(): void {
  const config = getConfig();

  const openclawConfig: Record<string, unknown> = {
    agents: {
      defaults: {
        workspace: getWorkspacePath(),
        model: { primary: config.model },
      },
    },
    gateway: {
      port: config.gatewayPort,
      mode: "local",
      auth: { token: config.gatewayToken },
    },
    plugins: {
      load: { paths: [getTlonPluginPath()] },
      entries: { tlon: { enabled: true } },
    },
    channels: {
      tlon: {
        enabled: true,
        ship: config.moonId,
        code: config.moonCode,
        url: `http://localhost:${config.verePort}`,
        ownerShip: config.ownerShip,
        dmAllowlist: [config.ownerShip],
        allowPrivateNetwork: true,
        autoDiscoverChannels: true,
      },
    },
    tools: {
      allow: ["web_fetch", "message", "web_search", "read", "tlon"],
      deny: ["bash", "canvas", "exec", "gateway", "nodes", "process"],
      elevated: { enabled: false },
    },
    session: { dmScope: "per-channel-peer" },
  };

  // Add API key configuration based on provider
  if (config.apiProvider !== "minimax" && config.apiKey) {
    const env: Record<string, string> = {};
    if (config.apiProvider === "anthropic") {
      env.ANTHROPIC_API_KEY = config.apiKey;
    } else if (config.apiProvider === "openrouter") {
      env.OPENROUTER_API_KEY = config.apiKey;
    }
    openclawConfig.env = env;
  }

  const configPath = getOpenClawConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(openclawConfig, null, 2), "utf-8");
}

export function installTlonPlugin(): void {
  const bundledPluginPath = path.join(
    process.resourcesPath || path.join(app.getAppPath(), "resources"),
    "tlon-plugin"
  );
  const targetPath = getTlonPluginPath();

  if (fs.existsSync(bundledPluginPath)) {
    fs.cpSync(bundledPluginPath, targetPath, { recursive: true });
  }
}
