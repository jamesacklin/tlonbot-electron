import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import {
  getVereBinaryPath,
  getPierPath,
  getConfig,
  setConfig,
  getLogsPath,
} from "../config";

export type VereState = "stopped" | "booting" | "running" | "error";

export class VereManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private state: VereState = "stopped";
  private logStream: fs.WriteStream | null = null;
  private restartCount = 0;
  private maxRestarts = 5;
  private restartDelay = 2000;
  private shutdownRequested = false;
  private httpPort: number | null = null;

  getState(): VereState {
    return this.state;
  }

  getHttpPort(): number | null {
    return this.httpPort;
  }

  private setState(state: VereState): void {
    this.state = state;
    this.emit("stateChange", state);
  }

  private openLogStream(): fs.WriteStream {
    const logPath = path.join(getLogsPath(), "vere.log");
    return fs.createWriteStream(logPath, { flags: "a" });
  }

  async boot(moonId: string, moonKey: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.shutdownRequested = false;
      this.setState("booting");
      this.logStream = this.openLogStream();

      const verePath = getVereBinaryPath();
      const pierPath = getPierPath();
      const config = getConfig();

      // First boot: create pier with moon credentials
      // ./urbit -w <moon-name> -G <key> -p <port> <pier-path>
      const args = [
        "-w", moonId,
        "-G", moonKey,
        "-p", String(config.verePort),
        pierPath,
      ];

      this.log(`Booting moon: ${verePath} ${args.join(" ")}`);

      this.process = spawn(verePath, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let codeExtracted = false;
      let bootComplete = false;

      const onData = (data: Buffer) => {
        const text = data.toString();
        this.log(text);

        // Detect HTTP server live
        const httpMatch = text.match(
          /http: web interface live on http:\/\/localhost:(\d+)/
        );
        if (httpMatch) {
          this.httpPort = parseInt(httpMatch[1], 10);
          bootComplete = true;
          this.setState("running");
          this.restartCount = 0;
          this.emit("ready", this.httpPort);

          // Now extract +code
          setTimeout(() => {
            this.extractCode()
              .then((code) => resolve(code))
              .catch(reject);
          }, 2000);
        }

        // Detect +code response (pattern: ~sampel-sampel-sampel-sampel)
        if (!codeExtracted) {
          const codeMatch = text.match(
            /\s*(~?[a-z]{6}-[a-z]{6}-[a-z]{6}-[a-z]{6})\s*$/m
          );
          if (codeMatch && bootComplete) {
            const code = codeMatch[1].startsWith("~")
              ? codeMatch[1].slice(1)
              : codeMatch[1];
            codeExtracted = true;
            setConfig({ moonCode: code });
            this.emit("codeExtracted", code);
          }
        }
      };

      this.process.stdout?.on("data", onData);
      this.process.stderr?.on("data", (data: Buffer) => {
        this.log(`[stderr] ${data.toString()}`);
      });

      this.process.on("error", (err) => {
        this.log(`Process error: ${err.message}`);
        this.setState("error");
        reject(err);
      });

      this.process.on("exit", (code) => {
        this.log(`Process exited with code ${code}`);
        if (!this.shutdownRequested && !bootComplete) {
          this.setState("error");
          reject(new Error(`vere exited during boot with code ${code}`));
        }
      });

      // Timeout for boot
      setTimeout(() => {
        if (!bootComplete) {
          this.log("Boot timeout after 5 minutes");
          this.setState("error");
          reject(new Error("vere boot timed out"));
        }
      }, 300000);
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.shutdownRequested = false;
      this.setState("booting");
      this.logStream = this.openLogStream();

      const verePath = getVereBinaryPath();
      const pierPath = getPierPath();
      const config = getConfig();

      // Subsequent boots: just pass pier path
      const args = [pierPath, "-p", String(config.verePort)];

      this.log(`Starting vere: ${verePath} ${args.join(" ")}`);

      this.process = spawn(verePath, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.process.stdout?.on("data", (data: Buffer) => {
        const text = data.toString();
        this.log(text);

        const httpMatch = text.match(
          /http: web interface live on http:\/\/localhost:(\d+)/
        );
        if (httpMatch) {
          this.httpPort = parseInt(httpMatch[1], 10);
          this.setState("running");
          this.restartCount = 0;
          this.emit("ready", this.httpPort);
          resolve();
        }
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        this.log(`[stderr] ${data.toString()}`);
      });

      this.process.on("error", (err) => {
        this.log(`Process error: ${err.message}`);
        this.setState("error");
        reject(err);
      });

      this.process.on("exit", (code) => {
        this.log(`Process exited with code ${code}`);
        if (!this.shutdownRequested) {
          this.setState("stopped");
          this.maybeRestart();
        }
      });

      setTimeout(() => {
        if (this.state === "booting") {
          this.setState("error");
          reject(new Error("vere start timed out"));
        }
      }, 120000);
    });
  }

  private extractCode(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error("No stdin available"));
        return;
      }

      let codeBuffer = "";

      const codeListener = (data: Buffer) => {
        codeBuffer += data.toString();
        const codeMatch = codeBuffer.match(
          /([a-z]{6}-[a-z]{6}-[a-z]{6}-[a-z]{6})/
        );
        if (codeMatch) {
          this.process?.stdout?.removeListener("data", codeListener);
          const code = codeMatch[1];
          setConfig({ moonCode: code });
          this.emit("codeExtracted", code);
          resolve(code);
        }
      };

      this.process.stdout?.on("data", codeListener);

      // Send +code command to dojo
      this.process.stdin.write("+code\n");

      setTimeout(() => {
        this.process?.stdout?.removeListener("data", codeListener);
        // If we already have a code in config, use that
        const existing = getConfig().moonCode;
        if (existing) {
          resolve(existing);
        } else {
          reject(new Error("Timed out waiting for +code response"));
        }
      }, 30000);
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

    if (!this.process) {
      this.setState("stopped");
      return;
    }

    return new Promise((resolve) => {
      const proc = this.process!;

      const forceKillTimer = setTimeout(() => {
        this.log("Force killing vere (SIGKILL)");
        proc.kill("SIGKILL");
      }, 10000);

      proc.on("exit", () => {
        clearTimeout(forceKillTimer);
        this.process = null;
        this.setState("stopped");
        this.logStream?.end();
        this.logStream = null;
        resolve();
      });

      this.log("Sending SIGTERM to vere");
      proc.kill("SIGTERM");
    });
  }

  isPierCreated(): boolean {
    const pierPath = getPierPath();
    return fs.existsSync(pierPath) && fs.existsSync(path.join(pierPath, ".urb"));
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}`;
    this.logStream?.write(line + "\n");
    this.emit("log", line);
  }
}
