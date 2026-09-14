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
});
