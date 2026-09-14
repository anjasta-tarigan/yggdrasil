import { describe, it, expect, vi } from "vitest";
import { createHfClient, isAllowedHfHost } from "../hf-client";
import { HfError } from "../types";

describe("hf-client", () => {
  describe("isAllowedHfHost", () => {
    it("strictly validates allowed hosts with exact/suffix check", () => {
      expect(isAllowedHfHost("huggingface.co")).toBe(true);
      expect(isAllowedHfHost("cdn.hf.co")).toBe(true);
      expect(isAllowedHfHost("us.aws.cdn.hf.co")).toBe(true);
      expect(isAllowedHfHost("hf.co")).toBe(true);
      expect(isAllowedHfHost("sub.hf.co")).toBe(true);
      expect(isAllowedHfHost("HUGGINGFACE.CO")).toBe(true);
      expect(isAllowedHfHost("Us.Aws.Cdn.Hf.Co")).toBe(true);

      expect(isAllowedHfHost("evil-hf.co")).toBe(false);
      expect(isAllowedHfHost("hf.co.attacker.net")).toBe(false);
      expect(isAllowedHfHost("huggingface.co.evil.com")).toBe(false);
      expect(isAllowedHfHost("evil-huggingface.co")).toBe(false);
      expect(isAllowedHfHost("example.com")).toBe(false);
      expect(isAllowedHfHost("")).toBe(false);
    });
  });

  describe("fetchWithRedirects", () => {
    it("follows redirects up to 5 hops and validates target host at each hop", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(null, {
          status: 302,
          headers: { Location: "https://us.aws.cdn.hf.co/model.onnx" },
        }))
        .mockResolvedValueOnce(new Response("model bytes", { status: 200 }));

      const client = createHfClient({ fetchImpl: mockFetch });
      const res = await client.fetchWithRedirects("https://huggingface.co/repo/resolve/main/model.onnx");
      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("resolves relative redirect paths against current URL", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(null, {
          status: 307,
          headers: { Location: "/api/resolve-cache/model.onnx" },
        }))
        .mockResolvedValueOnce(new Response("model bytes", { status: 200 }));

      const client = createHfClient({ fetchImpl: mockFetch });
      const res = await client.fetchWithRedirects("https://huggingface.co/repo/resolve/main/model.onnx");
      expect(res.status).toBe(200);
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "https://huggingface.co/api/resolve-cache/model.onnx",
        expect.anything()
      );
    });

    it("rejects redirects to unallowed hosts", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: "https://evil.com/model.onnx" },
      }));

      const client = createHfClient({ fetchImpl: mockFetch });
      await expect(client.fetchWithRedirects("https://huggingface.co/repo/resolve/main/model.onnx"))
        .rejects.toThrow(HfError);
    });

    it("rejects non-https URLs", async () => {
      const mockFetch = vi.fn();
      const client = createHfClient({ fetchImpl: mockFetch });
      await expect(client.fetchWithRedirects("http://huggingface.co/model.onnx"))
        .rejects.toThrow(HfError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects redirect responses without Location header", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302 }));
      const client = createHfClient({ fetchImpl: mockFetch });
      await expect(client.fetchWithRedirects("https://huggingface.co/model.onnx"))
        .rejects.toThrow(/without Location header/);
    });

    it("throws when redirect limit of 5 hops is exceeded", async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        return Promise.resolve(new Response(null, {
          status: 302,
          headers: { Location: "https://huggingface.co/redirect-target" },
        }));
      });

      const client = createHfClient({ fetchImpl: mockFetch });
      await expect(client.fetchWithRedirects("https://huggingface.co/start"))
        .rejects.toThrow(/Too many redirects/);
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it("throws HfError on non-ok HTTP status with status code", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
      const client = createHfClient({ fetchImpl: mockFetch });
      const errorPromise = client.fetchWithRedirects("https://huggingface.co/api/models/missing");
      await expect(errorPromise).rejects.toThrow(HfError);
      try {
        await client.fetchWithRedirects("https://huggingface.co/api/models/missing");
      } catch (err) {
        expect(err).toBeInstanceOf(HfError);
        expect((err as HfError).status).toBe(404);
      }
    });

    it("includes user-agent header and preserves custom headers", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response("ok", { status: 200 }));
      const client = createHfClient({ fetchImpl: mockFetch });
      await client.fetchWithRedirects("https://huggingface.co/api/models", {
        headers: { Authorization: "Bearer test-token" },
      });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://huggingface.co/api/models",
        expect.objectContaining({
          redirect: "manual",
          headers: expect.objectContaining({
            "user-agent": "yggdrasil/0.1 (onnx-installer)",
            Authorization: "Bearer test-token",
          }),
        })
      );
    });
  });

  describe("searchModels", () => {
    it("searches embedding models with feature-extraction pipeline tag and full=true", async () => {
      const mockResults = [
        { id: "Xenova/all-MiniLM-L6-v2", downloads: 1000, likes: 50, siblings: [{ rfilename: "onnx/model.onnx" }] }
      ];
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(mockResults), { status: 200 }));

      const client = createHfClient({ fetchImpl: mockFetch });
      const results = await client.searchModels("minilm", "embedding");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("Xenova/all-MiniLM-L6-v2");

      const calledUrl = new URL(mockFetch.mock.calls[0][0]);
      expect(calledUrl.searchParams.get("search")).toBe("minilm");
      expect(calledUrl.searchParams.get("filter")).toBe("transformers.js");
      expect(calledUrl.searchParams.get("pipeline_tag")).toBe("feature-extraction");
      expect(calledUrl.searchParams.get("full")).toBe("true");
      expect(calledUrl.searchParams.get("limit")).toBe("20");
    });

    it("searches reranker models with text-classification pipeline tag", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

      const client = createHfClient({ fetchImpl: mockFetch });
      await client.searchModels("bge-reranker", "reranker");

      const calledUrl = new URL(mockFetch.mock.calls[0][0]);
      expect(calledUrl.searchParams.get("pipeline_tag")).toBe("text-classification");
    });
  });

  describe("getModelTree", () => {
    it("queries tree recursive=true for specified repo", async () => {
      const mockTree = [
        { path: "config.json", type: "file", size: 1024 },
        { path: "onnx/model.onnx", type: "file", size: 50000000 },
      ];
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(mockTree), { status: 200 }));

      const client = createHfClient({ fetchImpl: mockFetch });
      const tree = await client.getModelTree("Xenova/all-MiniLM-L6-v2");
      expect(tree).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2/tree/main?recursive=true",
        expect.anything()
      );
    });
  });

  describe("getModelInfo", () => {
    it("queries repo model info endpoint", async () => {
      const mockInfo = {
        id: "Xenova/bge-reranker-base",
        pipeline_tag: "text-classification",
        tags: ["transformers.js"],
      };
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(mockInfo), { status: 200 }));

      const client = createHfClient({ fetchImpl: mockFetch });
      const info = await client.getModelInfo("Xenova/bge-reranker-base");
      expect(info.id).toBe("Xenova/bge-reranker-base");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://huggingface.co/api/models/Xenova/bge-reranker-base",
        expect.anything()
      );
    });
  });
});
