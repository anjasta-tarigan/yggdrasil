import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { HfClient } from "./hf-client";
import { HfError } from "./types";
import { syslog } from "@/lib/observability/log-store";

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

export class InsufficientDiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientDiskError";
  }
}

export interface DownloadOptions {
  client: HfClient;
  url: string;
  targetPath: string;
  expectedBytes?: number;
  expectedSha256?: string; // from lfs.oid
  onProgress?: (bytesDownloaded: number, totalBytes: number) => void;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  maxRetries?: number;
}

/** Best-effort synchronous unlink. Swallows errors during cleanup paths. */
function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    syslog("debug", "downloader", `safeUnlink: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Extract a Node.js `code` from an unknown error value, if present. */
function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

async function downloadFileAttempt(params: {
  client: HfClient;
  url: string;
  targetPath: string;
  expectedBytes?: number;
  expectedSha256?: string;
  onProgress?: (bytesDownloaded: number, totalBytes: number) => void;
  signal?: AbortSignal;
  idleTimeoutMs: number;
}): Promise<void> {
  const { client, url, targetPath, expectedBytes, expectedSha256, onProgress, signal, idleTimeoutMs } = params;

  let startBytes = 0;
  if (fs.existsSync(targetPath)) {
    try {
      startBytes = fs.statSync(targetPath).size;
    } catch (err) {
      syslog("debug", "downloader", `statSync target failed: ${err instanceof Error ? err.message : String(err)}`);
      startBytes = 0;
    }
  } else if (fs.existsSync(`${targetPath}.part`)) {
    // Adopt any legacy .part file directly into targetPath
    try {
      fs.renameSync(`${targetPath}.part`, targetPath);
      startBytes = fs.statSync(targetPath).size;
    } catch (err) {
      syslog("debug", "downloader", `renameSync .part failed: ${err instanceof Error ? err.message : String(err)}`);
      startBytes = 0;
    }
  }

  // If the existing file is already larger than expected, it is corrupted.
  if (expectedBytes && startBytes > expectedBytes) {
    safeUnlink(targetPath);
    startBytes = 0;
  }

  // If already at expected byte count and sha256 is present, verify hash directly without network call.
  if (expectedBytes && startBytes === expectedBytes && expectedSha256) {
    const existingHash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(targetPath)) {
      existingHash.update(chunk);
    }
    const actualSha = existingHash.digest("hex");
    if (actualSha.toLowerCase() === expectedSha256.toLowerCase()) {
      onProgress?.(startBytes, startBytes);
      return;
    }
    safeUnlink(targetPath);
    startBytes = 0;
  }

  const headers: Record<string, string> = {};
  if (startBytes > 0) {
    headers["Range"] = `bytes=${startBytes}-`;
  }

  let res: Response;
  try {
    res = await client.fetchWithRedirects(url, { headers, signal });
  } catch (err) {
    if (signal?.aborted ?? false) {
      safeUnlink(targetPath);
      throw new Error("Download aborted");
    }
    // If Range header was sent but server answered 416 (Range Not Satisfiable), clear target and fetch from 0.
    if (err instanceof HfError && err.status === 416 && startBytes > 0) {
      safeUnlink(targetPath);
      startBytes = 0;
      res = await client.fetchWithRedirects(url, { signal });
    } else {
      throw err;
    }
  }

  const isResume = res.status === 206;
  if (!isResume && startBytes > 0) {
    startBytes = 0;
  }

  const serverContentLength = res.headers.get("content-length") ? Number(res.headers.get("content-length")) : undefined;
  const total = expectedBytes ?? (
    serverContentLength !== undefined
      ? serverContentLength + startBytes
      : 0
  );

  let currentBytes = startBytes;
  const hash = crypto.createHash("sha256");

  // If resumed, seed the hash with existing bytes so the final digest reflects the complete file.
  if (isResume && startBytes > 0 && expectedSha256) {
    for await (const chunk of fs.createReadStream(targetPath, { end: startBytes - 1 })) {
      hash.update(chunk);
    }
  }

  if (!res.body) {
    throw new Error("No response body to download");
  }

  const writeStream = fs.createWriteStream(targetPath, { flags: isResume ? "a" : "w" });

  const webStream = Readable.fromWeb(
    res.body as unknown as import("node:stream/web").ReadableStream,
  ) as Readable;

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      webStream.destroy(new Error(`Download stalled: no data received for ${idleTimeoutMs / 1000}s`));
    }, idleTimeoutMs);
  };

  resetIdleTimer();

  webStream.on("data", (chunk: unknown) => {
    resetIdleTimer();
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    currentBytes += buf.length;
    if (expectedSha256) hash.update(buf);
    onProgress?.(currentBytes, total);
  });

  let onAbort: (() => void) | null = null;
  if (signal) {
    onAbort = () => {
      webStream.destroy(new Error("Download aborted"));
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    await pipeline(webStream, writeStream);
  } catch (err) {
    if (signal?.aborted ?? false) {
      safeUnlink(targetPath);
      throw new Error("Download aborted");
    }
    if (errnoCode(err) === "ENOSPC") {
      safeUnlink(targetPath);
      throw new InsufficientDiskError("No space left on device while downloading model");
    }
    // Retain targetPath on network/stall errors so subsequent attempts resume via HTTP Range
    throw err;
  } finally {
    if (onAbort && signal) {
      signal.removeEventListener("abort", onAbort);
    }
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  // Verification:
  // If expectedBytes is provided:
  // Only fail on byte count mismatch if:
  // - expectedSha256 is present (strict LFS file with exact hash & size), OR
  // - serverContentLength was provided and currentBytes !== (isResume ? startBytes + serverContentLength : serverContentLength)
  //   (which indicates the stream was truncated mid-transfer).
  if (expectedBytes && currentBytes !== expectedBytes) {
    const isTruncated = serverContentLength !== undefined && currentBytes !== (isResume ? startBytes + serverContentLength : serverContentLength);
    if (expectedSha256 || isTruncated) {
      safeUnlink(targetPath);
      throw new IntegrityError(`Byte count mismatch: expected ${expectedBytes}, got ${currentBytes}`);
    }
  }

  if (expectedSha256) {
    const actualSha = hash.digest("hex");
    if (actualSha.toLowerCase() !== expectedSha256.toLowerCase()) {
      safeUnlink(targetPath);
      throw new IntegrityError(`Checksum mismatch: expected sha256 ${expectedSha256}, got ${actualSha}`);
    }
  }
}

export async function downloadFile(options: DownloadOptions): Promise<void> {
  const { client, url, targetPath, expectedBytes, expectedSha256, onProgress, signal } = options;
  const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
  const maxRetries = options.maxRetries ?? 3;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  let attempt = 0;
  while (true) {
    if (signal?.aborted ?? false) {
      safeUnlink(targetPath);
      throw new Error("Download aborted");
    }

    try {
      await downloadFileAttempt({
        client,
        url,
        targetPath,
        expectedBytes,
        expectedSha256,
        onProgress,
        signal,
        idleTimeoutMs,
      });
      return;
    } catch (err) {
      if (signal?.aborted ?? false) {
        safeUnlink(targetPath);
        throw new Error("Download aborted");
      }
      if (err instanceof IntegrityError || err instanceof InsufficientDiskError) {
        throw err;
      }
      if (err instanceof HfError && typeof err.status === "number" && err.status >= 400 && err.status < 500 && err.status !== 416) {
        safeUnlink(targetPath);
        throw err;
      }

      attempt++;
      if (attempt > maxRetries) {
        syslog("warn", "downloader", `Download of ${url} failed after ${maxRetries} retries: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }

      syslog("info", "downloader", `Download of ${url} interrupted (${err instanceof Error ? err.message : String(err)}), retrying ${attempt}/${maxRetries}...`);
      const backoffMs = Math.min(500 * attempt, 3000);
      await new Promise<void>((resolve, reject) => {
        let onAbort: (() => void) | undefined;
        const timer = setTimeout(() => {
          if (signal && onAbort) {
            signal.removeEventListener("abort", onAbort);
          }
          resolve();
        }, backoffMs);
        if (signal) {
          onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort!);
            reject(new Error("Download aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
  }
}

/**
 * Best-effort synchronous check that the filesystem holding `dir` has at
 * least `requiredBytes` free. On Unix, shells out to `df`; on Windows
 * (no portable sync API) or when the check itself fails, returns `true`
 * so the download proceeds and relies on the ENOSPC handler in
 * `downloadFile` to catch a real out-of-space condition.
 */
export function isSufficientDiskSpace(requiredBytes: number, dir: string = path.resolve(process.cwd(), "data/models")): boolean {
  if (process.platform === "win32") {
    return true;
  }
  try {
    const output = execFileSync("df", ["-kP", dir], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = output.trim().split("\n");
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const availableKB = parseInt(parts[3], 10);
      return availableKB * 1024 >= requiredBytes;
    }
    return true;
  } catch (err) {
    syslog("debug", "downloader", `isSufficientDiskSpace df check failed: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}
