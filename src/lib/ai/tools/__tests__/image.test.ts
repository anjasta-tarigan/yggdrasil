import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/image-search", () => ({
  runImageSearch: vi.fn(),
}));

import { image_search } from "../image";
import { runImageSearch } from "@/lib/image-search";

describe("image_search Tool Definition", () => {
  beforeEach(() => {
    vi.mocked(runImageSearch).mockReset();
  });

  it("exposes description and schema matching requirements", () => {
    expect(image_search.description).toBeDefined();
    expect(image_search.description).toContain("Use image search selectively");
    expect(image_search.description).toContain("Prioritize authoritative sources over quantity");
    expect(image_search.inputSchema).toBeDefined();
  });

  it("executes search and returns structured results", async () => {
    const mockOutcome = {
      query: "NVIDIA RTX 5090",
      provider: "exa" as const,
      results: [
        {
          title: "GeForce RTX 5090",
          image_url: "https://nvidia.com/5090.jpg",
          source_url: "https://nvidia.com/5090",
          source_name: "nvidia.com",
          rank: 1,
        },
      ],
      attempts: [{ provider: "exa" as const, ok: true }],
    };

    vi.mocked(runImageSearch).mockResolvedValueOnce(mockOutcome);

    // AI SDK tools can be executed directly
    const result = await (
      image_search as unknown as {
        execute: (
          input: Record<string, unknown>,
          opts: unknown
        ) => Promise<unknown>;
      }
    ).execute(
      {
        query: "NVIDIA RTX 5090",
        count: 4,
        safe_search: true,
        preferred_domains: ["nvidia.com"],
        aspect_ratio: "landscape",
      },
      { toolCallId: "call_1", messages: [], context: {} }
    );

    expect(result).toEqual(mockOutcome);
    expect(runImageSearch).toHaveBeenCalledWith("NVIDIA RTX 5090", {
      count: 4,
      safe_search: true,
      preferred_domains: ["nvidia.com"],
      aspect_ratio: "landscape",
      min_width: undefined,
      min_height: undefined,
    });
  });

  it("gracefully catches search failures and returns empty results with error message", async () => {
    vi.mocked(runImageSearch).mockRejectedValueOnce(
      new Error("All image search providers failed")
    );

    const result = await (
      image_search as unknown as {
        execute: (
          input: Record<string, unknown>,
          opts: unknown
        ) => Promise<unknown>;
      }
    ).execute(
      { query: "Unavailable query" },
      { toolCallId: "call_2", messages: [], context: {} }
    );

    expect(result).toEqual({
      query: "Unavailable query",
      results: [],
      error: "All image search providers failed",
    });
  });
});
