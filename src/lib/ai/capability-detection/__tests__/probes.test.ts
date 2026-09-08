import { describe, it, expect, vi, beforeEach } from "vitest";
import { probeModality } from "@/lib/ai/capability-detection/probes";

describe("probeModality", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns supported: true when endpoint returns 200 OK", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "I see a pixel" } }] }),
    } as unknown as Response);

    const res = await probeModality({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      kind: "openai-compatible",
      modelId: "gpt-4o",
      modality: "image",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-test",
          "Content-Type": "application/json",
        }),
      })
    );

    expect(res).toEqual({
      supported: true,
      errorClass: "unknown",
    });
  });

  it("classifies explicit modality unsupported errors as supported: false, errorClass: modality_not_supported", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "Image input is not supported for this model",
    } as unknown as Response);

    const res = await probeModality({
      baseUrl: "https://api.openai.com/v1",
      kind: "openai-compatible",
      modelId: "gpt-3.5-turbo",
      modality: "image",
    });

    expect(res).toEqual({
      supported: false,
      errorClass: "modality_not_supported",
    });
  });

  it("classifies vision not available error message as modality_not_supported", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "This model is text only, vision is not available" } }),
    } as unknown as Response);

    const res = await probeModality({
      baseUrl: "https://api.openai.com/v1",
      kind: "openai-compatible",
      modelId: "text-davinci-003",
      modality: "image",
    });

    expect(res).toEqual({
      supported: false,
      errorClass: "modality_not_supported",
    });
  });

  it("classifies 401/403 as auth error with supported: null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    } as unknown as Response);

    const res = await probeModality({
      baseUrl: "https://api.openai.com/v1",
      kind: "openai-compatible",
      modelId: "gpt-4o",
      modality: "image",
    });

    expect(res).toEqual({
      supported: null,
      errorClass: "auth",
    });
  });

  it("classifies 429 as rate_limit error with supported: null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => "Rate limit reached",
    } as unknown as Response);

    const res = await probeModality({
      baseUrl: "https://api.openai.com/v1",
      kind: "openai-compatible",
      modelId: "gpt-4o",
      modality: "image",
    });

    expect(res).toEqual({
      supported: null,
      errorClass: "rate_limit",
    });
  });

  it("classifies 500-599 as 5xx error with supported: null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service Unavailable",
    } as unknown as Response);

    const res = await probeModality({
      baseUrl: "https://api.openai.com/v1",
      kind: "openai-compatible",
      modelId: "gpt-4o",
      modality: "image",
    });

    expect(res).toEqual({
      supported: null,
      errorClass: "5xx",
    });
  });

  it("classifies network errors or generic unknown errors as unknown with supported: null", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network timeout"));

    const res = await probeModality({
      baseUrl: "https://api.openai.com/v1",
      kind: "openai-compatible",
      modelId: "gpt-4o",
      modality: "image",
    });

    expect(res).toEqual({
      supported: null,
      errorClass: "unknown",
    });
  });
});
