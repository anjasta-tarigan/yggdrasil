// src/lib/llama/__tests__/types.test.ts
import { describe, it, expect } from "vitest";
import {
  LlamaResourceError,
  DEFAULT_GGUF_PORT,
  GGUF_MODELS_DIRNAME,
  GGUF_PIDFILE,
  MIN_LLAMA_SERVER_BUILD,
  MODEL_DEFAULT_CTX,
  GB,
  MB,
} from "@/lib/llama/types";

describe("llama types", () => {
  it("exposes the spec-pinned constants verbatim", () => {
    expect(DEFAULT_GGUF_PORT).toBe(2301);
    expect(GGUF_MODELS_DIRNAME).toBe("GGUF-chatModel");
    expect(GGUF_PIDFILE).toBe(".llama-server.pid");
    expect(MIN_LLAMA_SERVER_BUILD).toBe(6000);
    expect(MODEL_DEFAULT_CTX).toBe(8192);
    expect(GB(1.5)).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(MB(512)).toBe(512 * 1024 ** 2);
  });

  it("LlamaResourceError carries its message with the right name", () => {
    const err = new LlamaResourceError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LlamaResourceError");
    expect(err.message).toBe("boom");
  });
});
