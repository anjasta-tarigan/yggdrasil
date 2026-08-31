"use client";

import { GlobeIcon, SearchIcon } from "lucide-react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { getToolName } from "ai";
import type { DynamicToolUIPart, ToolUIPart } from "ai";

type SearchOutput = {
  query?: string;
  /** Which search provider answered (exa / firecrawl / searxng). */
  provider?: string;
  results?: Array<{ title?: string; url?: string; snippet?: string }>;
  /** Parallel-style MCP output: dense excerpts instead of result rows. */
  excerpts?: Array<{
    title?: string;
    url?: string;
    text?: string;
    excerpt?: string;
    snippet?: string;
  }>;
};

type FetchOutput = {
  url?: string;
  title?: string;
  markdown?: string;
  truncated?: boolean;
};

/** Underlying research tool names (builtin and MCP-duplicate alike). */
const RESEARCH_TOOL_NAMES = new Set(["web_search", "web_fetch", "fetch_page"]);

/** MCP slug separator used by the tool collector ("slug__toolName"). */
const MCP_SLUG_SEPARATOR = "__";

export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Parsed research-tool identity for one tool part name. */
export type ResearchToolInfo = {
  /** Underlying tool name ("web_search", "web_fetch", …). */
  base: string;
  /** MCP server slug when the tool came from a slugged MCP name. */
  mcpServer?: string;
};

/**
 * Classify a tool name as a research tool. Matches builtins exactly and
 * MCP-slugged duplicates by their suffix: "parallel-search__web_search"
 * classifies as web_search from server "parallel-search". Non-research
 * names return undefined.
 */
export function researchToolInfo(name: string): ResearchToolInfo | undefined {
  if (RESEARCH_TOOL_NAMES.has(name)) return { base: name };
  const sep = name.indexOf(MCP_SLUG_SEPARATOR);
  if (sep !== -1) {
    const suffix = name.slice(sep + MCP_SLUG_SEPARATOR.length);
    if (RESEARCH_TOOL_NAMES.has(suffix)) {
      return { base: suffix, mcpServer: name.slice(0, sep) };
    }
  }
  return undefined;
}

/** Normalize an MCP slug ("parallel-search") to a display label. */
function serverLabel(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Pull search results out of any known search output shape — builtin
 * (`results`) or Parallel-style MCP (`excerpts`) — normalized to the
 * sources-list shape. Returns undefined when there is nothing usable.
 */
export function extractSearchResults(
  output: SearchOutput | undefined
): Array<{ title: string; url: string; snippet?: string }> | undefined {
  if (!output) return undefined;
  const rows = Array.isArray(output.results) ? output.results : undefined;
  const excerpts = Array.isArray(output.excerpts) ? output.excerpts : undefined;
  const source = rows ?? excerpts;
  if (!source || source.length === 0) return undefined;
  const normalized: Array<{ title: string; url: string; snippet?: string }> = [];
  for (const entry of source) {
    const url =
      typeof entry?.url === "string" && entry.url.length > 0
        ? entry.url
        : undefined;
    if (!url) continue;
    const text =
      (entry as { text?: string }).text ??
      (entry as { excerpt?: string }).excerpt ??
      entry.snippet;
    normalized.push({
      title: entry.title ?? safeHostname(url),
      url,
      snippet: typeof text === "string" ? text : undefined,
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

type ResearchTrailProps = {
  parts: Array<ToolUIPart | DynamicToolUIPart>;
};

/**
 * Synthesizes a step-by-step research trail from web_search / web_fetch
 * tool invocations using the ChainOfThought component. MCP research
 * tools (e.g. "parallel-search__web_search") join the same trail with a
 * "Calling MCP {Server}" description and their own result shapes.
 */
export function ResearchTrail({ parts }: ResearchTrailProps) {
  return (
    <ChainOfThought className="mb-4" defaultOpen>
      <ChainOfThoughtHeader>
        {`Research — ${parts.length} step${parts.length === 1 ? "" : "s"}`}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {parts.map((part) => {
          const name = getToolName(part);
          const info = researchToolInfo(name) ?? { base: "web_fetch" };
          const running =
            part.state === "input-streaming" ||
            part.state === "input-available";
          // A part frozen in approval-requested (e.g. an interrupted
          // stream) never resolves — show it as waiting, not complete.
          const awaiting = part.state === "approval-requested";
          const status = running ? "active" : awaiting ? "pending" : "complete";
          const input = (part.input ?? {}) as Record<string, unknown>;
          const output =
            part.state === "output-available" ? part.output : undefined;

          // MCP steps say which server they are calling.
          const via =
            info.mcpServer !== undefined
              ? `${running ? "Calling MCP" : "Called MCP"} ${serverLabel(info.mcpServer)}`
              : undefined;

          if (info.base === "web_search") {
            const query = String(input.query ?? "");
            const searchQueries = Array.isArray(input.search_queries)
              ? (input.search_queries as unknown[]).map(String).join(", ")
              : "";
            const labelQuery = query || searchQueries;
            const searchOutput = output as SearchOutput | undefined;
            const results = extractSearchResults(searchOutput);
            return (
              <ChainOfThoughtStep
                description={
                  info.mcpServer !== undefined
                    ? via
                    : searchOutput?.provider
                      ? `via ${searchOutput.provider}`
                      : undefined
                }
                icon={SearchIcon}
                key={part.toolCallId}
                label={`${awaiting ? "Search awaiting approval" : running ? "Searching" : "Searched"}${labelQuery ? ` for “${labelQuery}”` : ""}`}
                status={status}
              >
                {results && results.length > 0 && (
                  <ChainOfThoughtSearchResults>
                    {results.slice(0, 5).map((result, i) => (
                      <ChainOfThoughtSearchResult
                        key={result.url || `result-${i}-${result.title ?? ""}`}
                      >
                        {result.url ? safeHostname(result.url) : result.title}
                      </ChainOfThoughtSearchResult>
                    ))}
                  </ChainOfThoughtSearchResults>
                )}
              </ChainOfThoughtStep>
            );
          }

          // web_fetch (legacy name: fetch_page)
          const url = String(input.url ?? "");
          const title = (output as FetchOutput | undefined)?.title;
          return (
            <ChainOfThoughtStep
              description={info.mcpServer !== undefined ? via : title}
              icon={GlobeIcon}
              key={part.toolCallId}
              label={`${awaiting ? "Fetch awaiting approval" : running ? "Fetching" : "Fetched"} ${awaiting ? "" : url ? safeHostname(url) : "page"}`}
              status={status}
            />
          );
        })}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}
