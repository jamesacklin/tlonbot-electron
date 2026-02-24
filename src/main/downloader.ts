import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { getBinPath, getVereBinaryPath } from "./config";

type ProgressCallback = (percent: number, downloaded: number, total: number) => void;

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
    .get(url, (res) => {
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
            // Rename tmp to final path
            fs.renameSync(tmpPath, targetPath);
            // Make executable
            fs.chmodSync(targetPath, 0o755);
            resolve(targetPath);
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
