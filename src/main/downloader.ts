import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as zlib from "zlib";
import { spawnSync } from "child_process";
import { getBinPath, getVereBinaryPath } from "./config";

type ProgressCallback = (percent: number, downloaded: number, total: number) => void;

const TAR_BUFFER_LIMIT = 64 * 1024 * 1024;

function isGzip(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function isMachO(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const magic = buffer.readUInt32BE(0);
  return [
    0xfeedface, // MH_MAGIC
    0xcefaedfe, // MH_CIGAM
    0xfeedfacf, // MH_MAGIC_64
    0xcffaedfe, // MH_CIGAM_64
    0xcafebabe, // FAT_MAGIC
    0xbebafeca, // FAT_CIGAM
  ].includes(magic);
}

function tryExtractFromTar(archivePath: string, outputPath: string): boolean {
  const listResult = spawnSync("tar", ["-tf", archivePath], {
    encoding: "utf-8",
    maxBuffer: TAR_BUFFER_LIMIT,
  });

  if (listResult.status !== 0) {
    return false;
  }

  const entries = listResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith("/"));

  if (entries.length === 0) {
    throw new Error("Tar archive did not contain a binary payload");
  }

  const payloadEntry = entries[0];
  const extractResult = spawnSync("tar", ["-xOf", archivePath, payloadEntry], {
    maxBuffer: TAR_BUFFER_LIMIT,
  });

  if (extractResult.status !== 0 || !(extractResult.stdout instanceof Buffer)) {
    throw new Error("Failed to extract vere binary from tar archive");
  }

  fs.writeFileSync(outputPath, extractResult.stdout);
  return true;
}

function getVereDownloadUrl(): string {
  const arch = os.arch() === "arm64" ? "aarch64" : "x86_64";
  return `https://urbit.org/install/macos-${arch}/latest`;
}

function followRedirects(
  url: string,
  onResponse: (res: http.IncomingMessage) => void,
  onError: (err: Error) => void,
  maxRedirects = 10
): void {
  if (maxRedirects <= 0) {
    onError(new Error("Too many redirects"));
    return;
  }

  const protocol = url.startsWith("https") ? https : http;
  protocol
    .get(url, { headers: { "Accept-Encoding": "identity" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        res.resume();
        followRedirects(redirectUrl, onResponse, onError, maxRedirects - 1);
      } else {
        onResponse(res);
      }
    })
    .on("error", onError);
}

export function isVereInstalled(): boolean {
  return fs.existsSync(getVereBinaryPath());
}

export function downloadVere(onProgress?: ProgressCallback): Promise<string> {
  return new Promise((resolve, reject) => {
    const binDir = getBinPath();
    fs.mkdirSync(binDir, { recursive: true });

    const targetPath = getVereBinaryPath();
    const tmpPath = targetPath + ".tmp";
    const url = getVereDownloadUrl();

    const file = fs.createWriteStream(tmpPath);

    followRedirects(
      url,
      (res) => {
        if (res.statusCode !== 200) {
          fs.unlinkSync(tmpPath);
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }

        const totalSize = parseInt(res.headers["content-length"] || "0", 10);
        let downloaded = 0;

        res.on("data", (chunk: Buffer) => {
          downloaded += chunk.length;
          if (onProgress && totalSize > 0) {
            onProgress(Math.round((downloaded / totalSize) * 100), downloaded, totalSize);
          }
        });

        res.pipe(file);

        file.on("finish", () => {
          file.close(() => {
            try {
              // Some endpoints return gzip-wrapped payloads. Normalize first.
              const tmpData = fs.readFileSync(tmpPath);
              if (isGzip(tmpData)) {
                fs.writeFileSync(tmpPath, zlib.gunzipSync(tmpData));
              }

              const wasTar = tryExtractFromTar(tmpPath, targetPath);
              if (!wasTar) {
                fs.renameSync(tmpPath, targetPath);
              } else {
                fs.unlinkSync(tmpPath);
              }

              const binaryHeader = fs.readFileSync(targetPath).subarray(0, 4);
              if (!isMachO(binaryHeader)) {
                throw new Error("Downloaded vere payload is not a macOS executable");
              }

              // Make executable
              fs.chmodSync(targetPath, 0o755);
              resolve(targetPath);
            } catch (err) {
              if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
              if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
              reject(err as Error);
            }
          });
        });
      },
      (err) => {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        reject(err);
      }
    );

    file.on("error", (err) => {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      reject(err);
    });
  });
}

export function getArchitectureLabel(): string {
  return os.arch() === "arm64" ? "Apple Silicon" : "Intel";
}
