import { ChildProcess, spawn, spawnSync } from "child_process";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as net from "net";
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
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private maxRestarts = 5;
  private restartDelay = 2000;
  private shutdownRequested = false;
  private httpPort: number | null = null;
  private readonly codePattern = /\b~?([a-z]{6}(?:-[a-z]{6}){3})\b/g;

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

  private reservePort(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();

      server.on("error", (err) => {
        reject(err);
      });

      server.listen({ host: "127.0.0.1", port }, () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          server.close();
          reject(new Error("Failed to resolve reserved port"));
          return;
        }

        const resolvedPort = addr.port;
        server.close((closeErr) => {
          if (closeErr) {
            reject(closeErr);
          } else {
            resolve(resolvedPort);
          }
        });
      });
    });
  }

  private async resolveAvailablePort(preferredPort: number): Promise<number> {
    if (!Number.isInteger(preferredPort) || preferredPort <= 0 || preferredPort > 65535) {
      throw new Error(`Invalid vere HTTP port: ${preferredPort}`);
    }

    try {
      await this.reservePort(preferredPort);
      return preferredPort;
    } catch (err: any) {
      if (err?.code === "EADDRINUSE") {
        throw new Error(
          `HTTP port ${preferredPort} is already in use. Free port ${preferredPort} and retry.`
        );
      }
      throw err;
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private assertVereBinaryUsable(verePath: string): void {
    const verify = spawnSync("codesign", ["--verify", "--verbose=2", verePath], {
      encoding: "utf-8",
    });

    if (verify.error) {
      throw new Error(`Unable to verify vere binary signature: ${verify.error.message}`);
    }

    if (verify.status !== 0) {
      const detail = `${verify.stdout ?? ""}${verify.stderr ?? ""}`.trim();
      throw new Error(
        `Vere binary has an invalid code signature. Re-download the runtime.${
          detail ? ` (${detail})` : ""
        }`
      );
    }
  }

  async boot(moonId: string, moonKey: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.clearRestartTimer();
      this.shutdownRequested = false;
      this.setState("booting");
      this.logStream = this.openLogStream();

      const verePath = getVereBinaryPath();
      const pierPath = getPierPath(moonId);
      const config = getConfig();
      this.assertVereBinaryUsable(verePath);

      // urbit -c requires the target pier path to not exist.
      // Clean up stale/partial first-run pier dirs before create.
      if (fs.existsSync(pierPath)) {
        const urbPath = path.join(pierPath, ".urb");
        let isUsablePier = false;

        if (fs.existsSync(urbPath)) {
          try {
            // Empty .urb directories are partial boot artifacts and not reusable.
            isUsablePier = fs.readdirSync(urbPath).length > 0;
          } catch {
            isUsablePier = false;
          }
        }

        if (!isUsablePier) {
          this.log(`Removing stale pre-boot pier directory at ${pierPath}`);
          fs.rmSync(pierPath, { recursive: true, force: true });
        }
      }

      this.resolveAvailablePort(config.verePort)
        .then((resolvedPort) => {
          // First boot (urbit 4.x):
          // ./urbit -w <moon-name> -G <key> -c <pier-path> --http-port <port>
          const moonName = moonId.trim().replace(/^~+/, "");
          const args = [
            "-t",
            "-w", moonName,
            "-G", moonKey,
            "-c", pierPath,
            "--http-port", String(resolvedPort),
          ];

          const redactedArgs = [
            "-t",
            "-w", moonName,
            "-G", "[redacted]",
            "-c", pierPath,
            "--http-port", String(resolvedPort),
          ];
          this.log(`Booting moon: ${verePath} ${redactedArgs.join(" ")}`);

          this.process = spawn(verePath, args, {
            stdio: ["pipe", "pipe", "pipe"],
          });

          let bootComplete = false;
          let settled = false;
          const safeResolve = (code: string) => {
            if (settled) return;
            settled = true;
            resolve(code);
          };
          const safeReject = (error: Error) => {
            if (settled) return;
            settled = true;
            reject(error);
          };

          const onData = (data: Buffer) => {
            const text = data.toString();
            this.log(text);

            // Detect HTTP server live
            const httpMatch = text.match(
              /http: web interface live on http:\/\/localhost:(\d+)/
            );
            if (httpMatch && !bootComplete) {
              this.httpPort = parseInt(httpMatch[1], 10);
              bootComplete = true;
              this.setState("running");
              this.restartCount = 0;
              this.emit("ready", this.httpPort);

              // Once Eyre is live, fetch +code over conn.sock via khan.
              void this.extractCode(pierPath, moonId)
                .then((code) => safeResolve(code))
                .catch((err: any) => {
                  this.setState("error");
                  safeReject(err instanceof Error ? err : new Error(String(err)));
                });
            }
          };

          this.process.stdout?.on("data", onData);
          this.process.stderr?.on("data", (data: Buffer) => {
            this.log(`[stderr] ${data.toString()}`);
          });

          this.process.on("error", (err) => {
            this.log(`Process error: ${err.message}`);
            this.setState("error");
            safeReject(err instanceof Error ? err : new Error(String(err)));
          });

          this.process.on("exit", (code, signal) => {
            this.log(`Process exited with code ${code} signal ${signal ?? "none"}`);
            if (!this.shutdownRequested && !settled) {
              this.setState("error");
              const details = code === null && signal ? `signal ${signal}` : `code ${code}`;
              safeReject(new Error(`vere exited during boot with ${details}`));
            }
          });

          // Timeout for boot
          setTimeout(() => {
            if (!settled) {
              this.log("Boot timeout after 5 minutes");
              this.setState("error");
              safeReject(new Error("vere boot timed out"));
            }
          }, 300000);
        })
        .catch((err: any) => {
          this.log(`Failed to resolve vere port: ${err.message}`);
          this.setState("error");
          const error = err instanceof Error ? err : new Error(String(err));
          reject(error);
        });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.clearRestartTimer();
      this.shutdownRequested = false;
      this.setState("booting");
      this.logStream = this.openLogStream();

      const verePath = getVereBinaryPath();
      const pierPath = getPierPath(getConfig().moonId);
      const config = getConfig();
      this.assertVereBinaryUsable(verePath);

      this.resolveAvailablePort(config.verePort)
        .then((resolvedPort) => {
          // Subsequent boots: existing pier with non-interactive mode.
          const args = ["-t", "--http-port", String(resolvedPort), pierPath];

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

          this.process.on("exit", (code, signal) => {
            this.log(`Process exited with code ${code} signal ${signal ?? "none"}`);
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
        })
        .catch((err: any) => {
          this.log(`Failed to resolve vere port: ${err.message}`);
          this.setState("error");
          reject(err);
        });
    });
  }

  async refreshCode(moonId?: string): Promise<string> {
    if (this.state !== "running") {
      throw new Error("Cannot refresh +code: vere is not running");
    }

    const resolvedMoonId = (moonId ?? getConfig().moonId).trim();
    if (!resolvedMoonId) {
      throw new Error("Cannot refresh +code: moon ID is not configured");
    }

    const pierPath = getPierPath(resolvedMoonId);
    return this.extractCode(pierPath, resolvedMoonId);
  }

  private async extractCode(pierPath: string, moonId: string): Promise<string> {
    const connSockPath = await this.waitForConnSocket(pierPath);
    const normalizedMoonId = moonId.trim().replace(/^~+/, "").toLowerCase();
    const maxAttempts = 30;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const code = await this.queryCodeOverConn(connSockPath, normalizedMoonId);
        setConfig({ moonCode: code });
        this.emit("codeExtracted", code);
        this.log(`+code extracted via conn.sock on attempt ${attempt}`);
        return code;
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.log(`+code extraction attempt ${attempt}/${maxAttempts} failed: ${lastError.message}`);
        if (attempt < maxAttempts) {
          await this.delay(1500);
        }
      }
    }

    throw new Error(
      `Timed out waiting for +code response via conn.sock${
        lastError ? `: ${lastError.message}` : ""
      }`
    );
  }

  private async waitForConnSocket(pierPath: string, timeoutMs = 60000): Promise<string> {
    const connSockPath = path.join(pierPath, ".urb", "conn.sock");
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const stats = fs.statSync(connSockPath);
        if (stats.isSocket()) {
          return connSockPath;
        }
      } catch {
        // Socket is not ready yet.
      }
      await this.delay(250);
    }

    throw new Error(`conn.sock not ready at ${connSockPath}`);
  }

  private async queryCodeOverConn(connSockPath: string, normalizedMoonId: string): Promise<string> {
    const codeThread =
      "=/  m  (strand ,vase)  ;<  our=@p  bind:m  get-our  ;<  code=@p  bind:m  " +
      "(scry @p /j/code/(scot %p our))  (pure:m !>((crip (slag 1 (scow %p code)))))";
    const request = `[0 %fyrd %base %khan-eval %noun %ted-eval '${codeThread}']\n`;
    const encodedRequest = await this.runUrbitEval(["-jn"], request);
    const connResponse = await this.sendConnPayload(connSockPath, encodedRequest);
    const decodedResponse = await this.runUrbitEval(["-ckn"], connResponse);
    const decodedText = this.stripAnsi(decodedResponse.toString("utf-8"));
    const matches = Array.from(decodedText.matchAll(this.codePattern), (match) =>
      match[1].toLowerCase()
    );

    const code = matches.find((match) => match !== normalizedMoonId);
    if (!code) {
      throw new Error("No +code value found in khan response");
    }

    return code;
  }

  private runUrbitEval(args: string[], input: string | Buffer, timeoutMs = 15000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const verePath = getVereBinaryPath();
      const proc = spawn(verePath, ["eval", ...args], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      let stderrText = "";
      let settled = false;

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        if (!settled) {
          settled = true;
          reject(new Error(`urbit eval ${args.join(" ")} timed out`));
        }
      }, timeoutMs);

      proc.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrText += chunk.toString();
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;

        const cleanStderr = this.stripAnsi(stderrText);
        const hasEvalError = /(?:bail:|bailing out|syntax error|corrupted newt|invalid argument)/i.test(
          cleanStderr
        );
        if (code !== 0 || signal || hasEvalError) {
          const reason = signal ? `signal ${signal}` : `code ${code}`;
          const detail = cleanStderr.trim();
          reject(
            new Error(
              `urbit eval ${args.join(" ")} failed (${reason})${detail ? `: ${detail}` : ""}`
            )
          );
          return;
        }

        resolve(Buffer.concat(stdoutChunks));
      });

      if (typeof input === "string") {
        proc.stdin?.end(input);
      } else {
        proc.stdin?.write(input);
        proc.stdin?.end();
      }
    });
  }

  private sendConnPayload(connSockPath: string, payload: Buffer, timeoutMs = 15000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: connSockPath });
      const chunks: Buffer[] = [];
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const totalTimer = setTimeout(() => {
        finish(new Error("Timed out waiting for conn.sock response"));
      }, timeoutMs);

      const clearTimers = () => {
        clearTimeout(totalTimer);
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const scheduleIdleFlush = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        // conn.c threaded replies may not close the socket; use inactivity as boundary.
        idleTimer = setTimeout(() => {
          finish(undefined, Buffer.concat(chunks));
        }, 1200);
      };

      const finish = (err?: Error, data?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimers();
        socket.destroy();
        if (err) {
          reject(err);
          return;
        }
        resolve(data ?? Buffer.alloc(0));
      };

      socket.on("connect", () => {
        socket.write(payload);
        scheduleIdleFlush();
      });

      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        scheduleIdleFlush();
      });

      socket.on("error", (err) => {
        finish(err instanceof Error ? err : new Error(String(err)));
      });

      socket.on("end", () => {
        finish(undefined, Buffer.concat(chunks));
      });

      socket.on("close", () => {
        if (!settled) {
          finish(undefined, Buffer.concat(chunks));
        }
      });
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, "");
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

    this.clearRestartTimer();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.shutdownRequested) {
        this.start().catch((err) => {
          this.log(`Restart failed: ${err.message}`);
        });
      }
    }, delay);
  }

  async stop(): Promise<void> {
    this.clearRestartTimer();
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
    const pierPath = getPierPath(getConfig().moonId);
    return fs.existsSync(pierPath) && fs.existsSync(path.join(pierPath, ".urb"));
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}`;
    this.logStream?.write(line + "\n");
    this.emit("log", line);
  }
}
