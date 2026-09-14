import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { HfClient } from "./hf-client";

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
}

/** Best-effort synchronous unlink. Swallows errors during cleanup paths. */
function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort: the .part file may be held by a concurrent process or
    // already removed. The primary error (IntegrityError, ENOSPC, abort)
    // is what the caller needs to see — this is a secondary cleanup.
  }
}

/** Extract a Node.js `code` from an unknown error value, if present. */
function errnoCode(err: unknown): string | undefined {
  if (err instanceof Error) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

export async function downloadFile(options: DownloadOptions): Promise<void> {
  const { client, url, targetPath, expectedBytes, expectedSha256, onProgress, signal } = options;
  const partPath = `${targetPath}.part`;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  let startBytes = 0;
  if (fs.existsSync(partPath)) {
    try {
      startBytes = fs.statSync(partPath).size;
    } catch {
      startBytes = 0;
    }
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
      safeUnlink(partPath);
      throw new Error("Download aborted");
    }
    safeUnlink(partPath);
    throw err;
  }

  const isResume = res.status === 206;
  const writeStream = fs.createWriteStream(partPath, { flags: isResume ? "a" : "w" });
  if (!isResume && startBytes > 0) {
    startBytes = 0;
  }

  const total = expectedBytes ?? (
    res.headers.get("content-length")
      ? Number(res.headers.get("content-length")) + startBytes
      : 0
  );

  let currentBytes = startBytes;
  const hash = crypto.createHash("sha256");

  // If resumed, seed the hash with existing .part bytes so the final digest
  // reflects the complete file.
  if (isResume && startBytes > 0 && expectedSha256) {
    const existing = fs.readFileSync(partPath);
    hash.update(existing);
  }

  if (!res.body) {
    writeStream.destroy();
    safeUnlink(partPath);
    throw new Error("No response body to download");
  }

  // res.body is a Web ReadableStream; Readable.fromWeb bridges to Node.
  // The DOM-lib and node:stream/web ReadableStream types are structurally
  // identical but nominally distinct, so bridge through unknown.
  const webStream = Readable.fromWeb(
    res.body as unknown as import("node:stream/web").ReadableStream,
  ) as Readable;
  webStream.on("data", (chunk: unknown) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    currentBytes += buf.length;
    if (expectedSha256) hash.update(buf);
    onProgress?.(currentBytes, total);
  });

  try {
    await pipeline(webStream, writeStream);
  } catch (err) {
    safeUnlink(partPath);
    if (errnoCode(err) === "ENOSPC") {
      throw new InsufficientDiskError("No space left on device while downloading model");
    }
    throw err;
  }

  // Verification
  if (expectedBytes && currentBytes !== expectedBytes) {
    safeUnlink(partPath);
    throw new IntegrityError(`Byte count mismatch: expected ${expectedBytes}, got ${currentBytes}`);
  }

  if (expectedSha256) {
    const actualSha = hash.digest("hex");
    if (actualSha.toLowerCase() !== expectedSha256.toLowerCase()) {
      safeUnlink(partPath);
      throw new IntegrityError(`Checksum mismatch: expected sha256 ${expectedSha256}, got ${actualSha}`);
    }
  }

  // Atomic rename
  fs.renameSync(partPath, targetPath);
}
