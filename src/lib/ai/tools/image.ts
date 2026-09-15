import { tool } from "ai";
import { z } from "zod";
import { runImageSearch } from "@/lib/image-search";

/**
 * Image Search Tool.
 *
 * Allows the AI model to search for real, externally hosted images from the web
 * and present them alongside normal AI responses with source attribution.
 *
 * Intended for retrieving existing images from the web (photos, products,
 * landmarks, vehicles, people, diagrams, UI references).
 * NOT for generating new images.
 */
export const image_search = tool({
  description:
    "Search the web for real, externally hosted images. Use image search selectively: for ordinary visual-reference requests, perform one focused image search and display only the single best image by default. Display a second image only when it adds meaningful visual information. Prioritize authoritative sources over quantity. Do not generate multiple search queries merely to increase the number of images. Do NOT call this tool for purely textual questions, code, math, translations, or requests to generate/create an original image. Formulate precise, specific natural-language search queries (e.g. 'NVIDIA GeForce RTX 5090 official product photo' rather than 'RTX', or 'early vacuum tube computer historical photograph' rather than 'computer').",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Natural-language image search query (e.g., 'NVIDIA GeForce RTX 5090 official product photo', 'Eiffel Tower Paris photograph')"
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2)
      .optional()
      .describe("Number of candidate images to retrieve (1-10, default 2; UI displays at most 1-2 for normal requests)"),
    safe_search: z
      .boolean()
      .default(true)
      .optional()
      .describe("Whether to enable safe search filtering (default true)"),
    preferred_domains: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of authoritative domains to prioritize (e.g., ['nvidia.com'])"
      ),
    aspect_ratio: z
      .enum(["square", "portrait", "landscape", "any"])
      .optional()
      .describe(
        "Optional desired aspect ratio ('square', 'portrait', 'landscape', or 'any')"
      ),
    min_width: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional minimum image width in pixels"),
    min_height: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional minimum image height in pixels"),
  }),
  execute: async ({
    query,
    count,
    safe_search,
    preferred_domains,
    aspect_ratio,
    min_width,
    min_height,
  }) => {
    try {
      return await runImageSearch(query, {
        count,
        safe_search,
        preferred_domains,
        aspect_ratio,
        min_width,
        min_height,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Return safe structured fallback so the agent can still deliver
      // its textual response without crashing the turn
      return {
        query,
        results: [],
        error: message,
      };
    }
  },
});
