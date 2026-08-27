import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "../embeddings/detect/route";

const detectMock = vi.fn();

vi.mock("@/lib/memory/embeddings", () => ({
  detectEmbeddingDimensions: (...args: unknown[]) => detectMock(...args),
}));

function request(body: string): Request {
  return new Request("http://localhost/api/embeddings/detect", {
    method: "POST",
    body,
  });
}

describe("Embeddings Detect API Handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns detected dimensions for a valid ollama probe", async () => {
    detectMock.mockResolvedValue({
      dimensions: 768,
      model: "nomic-embed-text",
      latencyMs: 42,
    });

    const res = await POST(
      request(
        JSON.stringify({
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          model: "nomic-embed-text",
        })
      )
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      dimensions: 768,
      model: "nomic-embed-text",
      latencyMs: 42,
    });
  });

  it("rejects invalid payloads", async () => {
    const cases = [
      "{}", // missing provider
      JSON.stringify({ provider: "anthropic" }), // unknown provider
      JSON.stringify({ provider: "ollama", baseUrl: "file:///etc/passwd" }),
      JSON.stringify({ provider: "ollama", baseUrl: "http://x", model: 42 }),
      "not json",
    ];
    for (const body of cases) {
      const res = await POST(request(body));
      expect(res.status).toBe(400);
    }
    expect(detectMock).not.toHaveBeenCalled();
  });

  it("returns 502 when the probe fails", async () => {
    detectMock.mockRejectedValue(new Error("endpoint unreachable"));
    const res = await POST(
      request(
        JSON.stringify({ provider: "ollama", baseUrl: "http://localhost:11434" })
      )
    );
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.error).toBe("endpoint unreachable");
  });
});
