import { app } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { spawnSync } from "child_process";

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

function normalizePort(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
}

function normalizeConfig(config: TlonBotConfig): TlonBotConfig {
  return {
    ...config,
    verePort: normalizePort(config.verePort, defaults.verePort),
    gatewayPort: normalizePort(config.gatewayPort, defaults.gatewayPort),
  };
}

function getConfigFilePath(): string {
  return path.join(app.getPath("userData"), "tlonbot-config.json");
}

function readStore(): TlonBotConfig {
  const filePath = getConfigFilePath();
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    const merged = { ...defaults, ...JSON.parse(data) } as TlonBotConfig;
    const normalized = normalizeConfig(merged);
    if (
      merged.verePort !== normalized.verePort ||
      merged.gatewayPort !== normalized.gatewayPort
    ) {
      writeStore(normalized);
    }
    return normalized;
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
  const updated = normalizeConfig({ ...current, ...partial } as TlonBotConfig);
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

function normalizeMoonName(moonId: string): string {
  return moonId.trim().replace(/^~+/, "").toLowerCase();
}

function hasUsablePier(pierPath: string): boolean {
  const urbPath = path.join(pierPath, ".urb");
  if (!fs.existsSync(urbPath)) return false;
  try {
    return fs.readdirSync(urbPath).length > 0;
  } catch {
    return false;
  }
}

export function getPiersPath(): string {
  return path.join(getAppDataPath(), "piers");
}

export function getLegacyPierPath(): string {
  return path.join(getAppDataPath(), "pier");
}

export function getPierPath(moonId?: string): string {
  const legacyPier = getLegacyPierPath();
  const hasExplicitMoon = typeof moonId === "string";
  const resolvedMoonId = moonId ?? getConfig().moonId;
  const moonName = normalizeMoonName(resolvedMoonId || "");

  if (!moonName) return legacyPier;

  const namedPier = path.join(getPiersPath(), moonName);
  // For explicit moon boot paths, never auto-fallback to legacy.
  if (hasExplicitMoon) return namedPier;

  // Migration fallback for older installs that already have a valid legacy pier.
  if (!fs.existsSync(namedPier) && hasUsablePier(legacyPier)) {
    return legacyPier;
  }

  return namedPier;
}

export function getOpenClawHome(): string {
  return path.join(getAppDataPath(), "openclaw");
}

export function getOpenClawStatePath(): string {
  return path.join(getOpenClawHome(), "state");
}

export function getGatewayBaseUrl(): string {
  const config = getConfig();
  return `http://localhost:${config.gatewayPort}`;
}

export function getDashboardUrl(includeToken = true): string {
  const baseUrl = getGatewayBaseUrl();
  if (!includeToken) return baseUrl;

  const token = getConfig().gatewayToken.trim();
  return token ? `${baseUrl}#token=${encodeURIComponent(token)}` : baseUrl;
}

export function getOpenClawConfigPath(): string {
  return path.join(getOpenClawHome(), "openclaw.json");
}

export function getLegacyOpenClawConfigPath(): string {
  return path.join(getOpenClawHome(), ".openclaw", "openclaw.json");
}

export function resolveOpenClawConfigPath(): string {
  const canonicalPath = getOpenClawConfigPath();
  if (fs.existsSync(canonicalPath)) return canonicalPath;

  const legacyPath = getLegacyOpenClawConfigPath();
  if (fs.existsSync(legacyPath)) return legacyPath;

  return canonicalPath;
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

function hasPluginManifest(pluginDir: string): boolean {
  return fs.existsSync(path.join(pluginDir, "openclaw.plugin.json"));
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getPluginVersion(pluginDir: string): string {
  const pkg = readJson(path.join(pluginDir, "package.json"));
  return typeof pkg?.version === "string" ? pkg.version : "";
}

function hasPluginRuntimeDependencies(pluginDir: string): boolean {
  return fs.existsSync(
    path.join(pluginDir, "node_modules", "@tloncorp", "api", "package.json")
  );
}

function formatSpawnFailure(result: ReturnType<typeof spawnSync>): string {
  const stdout = (result.stdout ?? "").toString().trim();
  const stderr = (result.stderr ?? "").toString().trim();
  return [stdout, stderr].filter((part) => part.length > 0).join("\n");
}

function installPluginDependencies(pluginDir: string): void {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCmd, ["install"], {
    cwd: pluginDir,
    encoding: "utf-8",
    env: {
      ...process.env,
      npm_config_fund: "false",
      npm_config_audit: "false",
    },
  });

  if (result.error || result.status !== 0) {
    const detail = result.error?.message || formatSpawnFailure(result) || "unknown npm error";
    throw new Error(`Failed to install Tlon plugin dependencies: ${detail}`);
  }
}

function resolveBundledPluginPath(): string {
  const appPath = app.getAppPath();
  const candidates = Array.from(
    new Set(
      [
        path.join(process.resourcesPath, "tlon-plugin"),
        path.join(appPath, "resources", "tlon-plugin"),
        path.join(appPath, "..", "tlon-plugin"),
        path.join(process.cwd(), "resources", "tlon-plugin"),
      ].map((candidate) => path.resolve(candidate))
    )
  );

  const bundledPath = candidates.find((candidate) => hasPluginManifest(candidate));
  if (!bundledPath) {
    throw new Error(
      `Bundled Tlon plugin not found. Checked: ${candidates.join(", ")}`
    );
  }

  return bundledPath;
}

function removeBundledOpenClawTlonPlugin(): void {
  const appPath = app.getAppPath();
  const openclawRoots = Array.from(
    new Set(
      [
        path.join(process.cwd(), "node_modules", "openclaw"),
        path.join(appPath, "node_modules", "openclaw"),
        path.join(appPath, "..", "node_modules", "openclaw"),
      ].map((candidate) => path.resolve(candidate))
    )
  );

  const bundledPluginPaths = ["extensions/tlon", "node_modules/tlon"];
  for (const root of openclawRoots) {
    if (!fs.existsSync(root)) continue;
    for (const relPath of bundledPluginPaths) {
      const fullPath = path.join(root, relPath);
      if (!fs.existsSync(fullPath)) continue;
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } catch {
        // Best-effort only; packaged app paths may be read-only.
      }
    }
  }
}

export function getLogsPath(): string {
  return path.join(getAppDataPath(), "logs");
}

export function ensureDirectories(): void {
  const dirs = [
    getBinPath(),
    getPiersPath(),
    getOpenClawHome(),
    getOpenClawStatePath(),
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
  const controlUiOrigins = [
    `http://localhost:${config.gatewayPort}`,
    `http://127.0.0.1:${config.gatewayPort}`,
    `http://[::1]:${config.gatewayPort}`,
  ];

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
      controlUi: {
        allowedOrigins: controlUiOrigins,
      },
    },
    plugins: {
      allow: ["tlon"],
      load: {
        paths: [getTlonPluginPath()],
      },
      entries: {
        tlon: { enabled: true },
      },
    },
    channels: {
      tlon: {
        enabled: true,
        ship: config.moonId,
        code: config.moonCode,
        url: `http://localhost:${config.verePort}`,
        ownerShip: config.ownerShip,
        inviteAllowlist: [config.ownerShip],
        groupInviteAllowlist: [config.ownerShip],
        defaultAuthorizedShips: [config.ownerShip],
        autoAcceptDmInvites: false,
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
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(openclawConfig, null, 2), "utf-8");
}

export function installTlonPlugin(): void {
  const targetPath = getTlonPluginPath();
  const bundledPath = resolveBundledPluginPath();
  const sourceVersion = getPluginVersion(bundledPath);
  const targetVersion = getPluginVersion(targetPath);
  const needsRefresh =
    !hasPluginManifest(targetPath) ||
    sourceVersion !== targetVersion ||
    !hasPluginRuntimeDependencies(targetPath);

  // Match the working setup script behavior: prefer external tlon extension.
  removeBundledOpenClawTlonPlugin();

  if (needsRefresh) {
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.cpSync(bundledPath, targetPath, { recursive: true });
  }

  if (!hasPluginRuntimeDependencies(targetPath)) {
    installPluginDependencies(targetPath);
  }

  if (!hasPluginManifest(targetPath) || !hasPluginRuntimeDependencies(targetPath)) {
    throw new Error(`Tlon plugin install is incomplete at ${targetPath}`);
  }
}
