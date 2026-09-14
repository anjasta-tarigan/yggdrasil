import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { downloadFile, IntegrityError, InsufficientDiskError } from "../download";
import { createHfClient } from "../hf-client";

const TMP = path.resolve(process.cwd(), "tmp/test-download");

describe("downloadFile", () => {
  beforeEach(() => {
    fs.mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("downloads file to .part and renames to target with correct sha256", async () => {
    const content = "hello onnx world";
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    const target = path.join(TMP, "model.onnx");

    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response(content, {
        status: 200,
        headers: { "content-length": String(content.length) },
      })
    );

    const client = createHfClient({ fetchImpl });

    await downloadFile({
      client,
      url: "https://huggingface.co/repo/resolve/main/model.onnx",
      targetPath: target,
      expectedSha256: sha,
      expectedBytes: content.length,
    });

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe(content);
  });

  it("throws IntegrityError and purges .part on sha256 mismatch", async () => {
    const content = "corrupted bytes";
    const target = path.join(TMP, "model.onnx");

    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response(content, { status: 200 })
    );

    const client = createHfClient({ fetchImpl });

    await expect(
      downloadFile({
        client,
        url: "https://huggingface.co/repo/resolve/main/model.onnx",
        targetPath: target,
        expectedSha256: "badhash123",
        expectedBytes: content.length,
      })
    ).rejects.toThrow(IntegrityError);

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
  });

  it("throws IntegrityError on byte count mismatch", async () => {
    const content = "short";
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    const target = path.join(TMP, "model.onnx");

    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response(content, { status: 200 })
    );

    const client = createHfClient({ fetchImpl });

    await expect(
      downloadFile({
        client,
        url: "https://huggingface.co/repo/resolve/main/model.onnx",
        targetPath: target,
        expectedSha256: sha,
        expectedBytes: 999, // wrong size
      })
    ).rejects.toThrow(IntegrityError);
  });

  it("does not fail when expectedBytes was an estimate and server delivers complete content", async () => {
    const content = "x".repeat(200); // 200 bytes
    const target = path.join(TMP, "config.json");

    const fetchImpl = vi.fn().mockImplementation(async () =>
      new Response(content, {
        status: 200,
        headers: { "content-length": "200" },
      })
    );

    const client = createHfClient({ fetchImpl });

    await downloadFile({
      client,
      url: "https://huggingface.co/repo/resolve/main/1_Pooling/config.json",
      targetPath: target,
      expectedBytes: 1024, // estimated size in plan
    });

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(content);
  });

  it("resumes from a partial .part file using Range header", async () => {
    const content = "hello onnx world resume test";
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    const target = path.join(TMP, "model.onnx");
    const partPath = `${target}.part`;

    // Pre-write 5 bytes to simulate a partial download
    fs.writeFileSync(partPath, "hello");
    const startBytes = 5;
    const remaining = content.slice(startBytes);

    let receivedRangeHeader = "";
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      receivedRangeHeader = (init?.headers as Record<string, string>)["Range"] ?? "";
      return new Response(remaining, {
        status: 206,
        headers: {
          "content-length": String(remaining.length),
          "content-range": `bytes ${startBytes}-${content.length - 1}/${content.length}`,
        },
      });
    });

    const client = createHfClient({ fetchImpl });

    await downloadFile({
      client,
      url: "https://huggingface.co/repo/resolve/main/model.onnx",
      targetPath: target,
      expectedSha256: sha,
      expectedBytes: content.length,
    });

    expect(receivedRangeHeader).toBe(`bytes=${startBytes}-`);
    expect(fs.readFileSync(target, "utf8")).toBe(content);
  });

  it("throws InsufficientDiskError on ENOSPC", async () => {
    const target = path.join(TMP, "model.onnx");

    const fetchImpl = vi.fn().mockImplementation(async () => {
      // Simulate ENOSPC by erroring the response body stream
      const stream = new ReadableStream({
        start(controller) {
          controller.error(
            Object.assign(new Error("disk full"), { code: "ENOSPC" })
          );
        },
      });
      return new Response(stream, { status: 200 });
    });

    const client = createHfClient({ fetchImpl });

    await expect(
      downloadFile({
        client,
        url: "https://huggingface.co/repo/resolve/main/model.onnx",
        targetPath: target,
        expectedBytes: 100,
      })
    ).rejects.toThrow(InsufficientDiskError);
  });

  it("retries and resumes via Range header when stream is interrupted", async () => {
    const fullContent = "0123456789abcdefghij"; // 20 bytes
    const sha = crypto.createHash("sha256").update(fullContent).digest("hex");
    const target = path.join(TMP, "model.onnx");

    let callCount = 0;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      callCount++;
      const headers = (init?.headers as Record<string, string>) ?? {};
      if (callCount === 1) {
        // First call: yield 10 bytes then simulate a connection drop
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(Buffer.from(fullContent.slice(0, 10)));
            await new Promise((r) => setTimeout(r, 10));
            controller.error(new Error("ECONNRESET: connection reset by peer"));
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-length": "20" },
        });
      } else {
        // Second call: range request for remaining 10 bytes
        expect(headers["Range"]).toBe("bytes=10-");
        const remaining = fullContent.slice(10);
        return new Response(remaining, {
          status: 206,
          headers: {
            "content-length": String(remaining.length),
            "content-range": `bytes 10-19/20`,
          },
        });
      }
    });

    const client = createHfClient({ fetchImpl });

    await downloadFile({
      client,
      url: "https://huggingface.co/repo/resolve/main/model.onnx",
      targetPath: target,
      expectedSha256: sha,
      expectedBytes: fullContent.length,
      maxRetries: 2,
    });

    expect(callCount).toBe(2);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(fullContent);
  });

  it("detects stalled stream using idleTimeoutMs and resumes on retry", async () => {
    const fullContent = "part1-data-part2-data";
    const sha = crypto.createHash("sha256").update(fullContent).digest("hex");
    const target = path.join(TMP, "model.onnx");

    let callCount = 0;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      callCount++;
      const headers = (init?.headers as Record<string, string>) ?? {};
      if (callCount === 1) {
        // First call: stream part 1, then stall indefinitely
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from(fullContent.slice(0, 11)));
            // Stalls without closing or emitting more chunks
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-length": String(fullContent.length) },
        });
      } else {
        // Resumed call: send remainder
        expect(headers["Range"]).toBe("bytes=11-");
        const remaining = fullContent.slice(11);
        return new Response(remaining, {
          status: 206,
          headers: {
            "content-length": String(remaining.length),
            "content-range": `bytes 11-${fullContent.length - 1}/${fullContent.length}`,
          },
        });
      }
    });

    const client = createHfClient({ fetchImpl });

    await downloadFile({
      client,
      url: "https://huggingface.co/repo/resolve/main/model.onnx",
      targetPath: target,
      expectedSha256: sha,
      expectedBytes: fullContent.length,
      idleTimeoutMs: 50,
      maxRetries: 2,
    });

    expect(callCount).toBe(2);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(fullContent);
  });

  it("purges .part file and stops when user aborts via signal", async () => {
    const target = path.join(TMP, "model.onnx");
    const controller = new AbortController();

    const fetchImpl = vi.fn().mockImplementation(async () => {
      // Abort caller controller as soon as stream starts
      const stream = new ReadableStream({
        start(streamController) {
          streamController.enqueue(Buffer.from("some initial bytes"));
          controller.abort();
        },
      });
      return new Response(stream, { status: 200 });
    });

    const client = createHfClient({ fetchImpl });

    await expect(
      downloadFile({
        client,
        url: "https://huggingface.co/repo/resolve/main/model.onnx",
        targetPath: target,
        signal: controller.signal,
        expectedBytes: 100,
      })
    ).rejects.toThrow("Download aborted");

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(`${target}.part`)).toBe(false);
  });
});
