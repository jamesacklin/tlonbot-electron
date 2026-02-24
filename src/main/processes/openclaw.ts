import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import {
  getConfig,
  getDashboardUrl,
  getOpenClawHome,
  getLogsPath,
} from "../config";

export type OpenClawState = "stopped" | "starting" | "running" | "error";

export class OpenClawManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private state: OpenClawState = "stopped";
  private logStream: fs.WriteStream | null = null;
  private restartCount = 0;
  private maxRestarts = 5;
  private restartDelay = 2000;
  private shutdownRequested = false;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private authHintEmitted = false;

  getState(): OpenClawState {
    return this.state;
  }

  private setState(state: OpenClawState): void {
    this.state = state;
    this.emit("stateChange", state);
  }

  private openLogStream(): fs.WriteStream {
    const logPath = path.join(getLogsPath(), "openclaw.log");
    return fs.createWriteStream(logPath, { flags: "a" });
  }

  private findOpenClawBinary(): string {
    // Look for openclaw in node_modules/.bin
    const localBin = path.join(
      __dirname,
      "..",
      "..",
      "node_modules",
      ".bin",
      "openclaw"
    );
    if (fs.existsSync(localBin)) return localBin;

    // In packaged app, look relative to app path
    const { app } = require("electron");
    const packagedBin = path.join(
      app.getAppPath(),
      "node_modules",
      ".bin",
      "openclaw"
    );
    if (fs.existsSync(packagedBin)) return packagedBin;

    // Fallback: try system PATH
    return "openclaw";
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.shutdownRequested = false;
      this.authHintEmitted = false;
      this.setState("starting");
      this.logStream = this.openLogStream();

      const config = getConfig();
      const openclawBin = this.findOpenClawBinary();

      const args = [
        "gateway",
        "--port",
        String(config.gatewayPort),
        "--bind",
        "lan",
        "--token",
        config.gatewayToken,
      ];

      const redactedArgs = [
        "gateway",
        "--port",
        String(config.gatewayPort),
        "--bind",
        "lan",
        "--token",
        "[redacted]",
      ];
      this.log(`Starting OpenClaw: ${openclawBin} ${redactedArgs.join(" ")}`);

      this.process = spawn(openclawBin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          OPENCLAW_HOME: getOpenClawHome(),
          OPENCLAW_GATEWAY_TOKEN: config.gatewayToken,
        },
      });

      this.process.stdout?.on("data", (data: Buffer) => {
        this.handleProcessOutput(data.toString(), false);
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        this.handleProcessOutput(data.toString(), true);
      });

      this.process.on("error", (err) => {
        this.log(`Process error: ${err.message}`);
        this.setState("error");
        reject(err);
      });

      this.process.on("exit", (code) => {
        this.log(`Process exited with code ${code}`);
        if (this.healthCheckInterval) {
          clearInterval(this.healthCheckInterval);
          this.healthCheckInterval = null;
        }
        if (!this.shutdownRequested) {
          this.setState("stopped");
          this.maybeRestart();
        }
      });

      // Poll for health
      this.waitForHealthy(config.gatewayPort)
        .then(() => {
          this.setState("running");
          this.restartCount = 0;
          this.emit("ready");
          resolve();
        })
        .catch((err) => {
          this.setState("error");
          reject(err);
        });
    });
  }

  private waitForHealthy(port: number, timeoutMs = 60000): Promise<void> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const check = () => {
        if (this.shutdownRequested) {
          reject(new Error("Shutdown requested"));
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          reject(new Error("OpenClaw health check timed out"));
          return;
        }

        const req = http.get(`http://localhost:${port}/health`, (res) => {
          if (res.statusCode === 200) {
            res.resume();
            resolve();
          } else {
            res.resume();
            setTimeout(check, 1000);
          }
        });

        req.on("error", () => {
          setTimeout(check, 1000);
        });

        req.setTimeout(2000, () => {
          req.destroy();
          setTimeout(check, 1000);
        });
      };

      // Wait a moment before first check
      setTimeout(check, 2000);
    });
  }

  private maybeRestart(): void {
    if (this.shutdownRequested) return;
    if (this.restartCount >= this.maxRestarts) {
      this.log("Max restarts reached, giving up");
      this.setState("error");
      this.emit("maxRestartsReached");
      return;
    }

    this.restartCount++;
    const delay = this.restartDelay * Math.pow(2, this.restartCount - 1);
    this.log(`Restarting in ${delay}ms (attempt ${this.restartCount}/${this.maxRestarts})`);

    setTimeout(() => {
      if (!this.shutdownRequested) {
        this.start().catch((err) => {
          this.log(`Restart failed: ${err.message}`);
        });
      }
    }, delay);
  }

  async stop(): Promise<void> {
    this.shutdownRequested = true;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (!this.process) {
      this.setState("stopped");
      return;
    }

    return new Promise((resolve) => {
      const proc = this.process!;

      const forceKillTimer = setTimeout(() => {
        this.log("Force killing OpenClaw (SIGKILL)");
        proc.kill("SIGKILL");
      }, 5000);

      proc.on("exit", () => {
        clearTimeout(forceKillTimer);
        this.process = null;
        this.setState("stopped");
        this.logStream?.end();
        this.logStream = null;
        resolve();
      });

      this.log("Sending SIGTERM to OpenClaw");
      proc.kill("SIGTERM");
    });
  }

  getGatewayUrl(): string {
    return getDashboardUrl(true);
  }

  private handleProcessOutput(output: string, isStderr: boolean): void {
    this.log(isStderr ? `[stderr] ${output}` : output);

    if (
      !this.authHintEmitted &&
      /unauthorized:\s*gateway token missing/i.test(output)
    ) {
      this.authHintEmitted = true;
      const dashboardUrl = getDashboardUrl(true);
      this.log(`Control UI auth missing; tokenized dashboard URL: ${dashboardUrl}`);
      this.emit("authRequired", { dashboardUrl });
    }
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}`;
    this.logStream?.write(line + "\n");
    this.emit("log", line);
  }
}
