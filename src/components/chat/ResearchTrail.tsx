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
};

type FetchOutput = {
  url?: string;
  title?: string;
  markdown?: string;
  truncated?: boolean;
};

export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

type ResearchTrailProps = {
  parts: Array<ToolUIPart | DynamicToolUIPart>;
};

/**
 * Synthesizes a step-by-step research trail from web_search / fetch_page
 * tool invocations using the ChainOfThought component.
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
          const running =
            part.state === "input-streaming" ||
            part.state === "input-available";
          const status = running ? "active" : "complete";
          const input = (part.input ?? {}) as Record<string, unknown>;
          const output =
            part.state === "output-available" ? part.output : undefined;

          if (name === "web_search") {
            const query = String(input.query ?? "");
            const searchOutput = output as SearchOutput | undefined;
            const results = searchOutput?.results;
            const via = searchOutput?.provider
              ? `via ${searchOutput.provider}`
              : undefined;
            return (
              <ChainOfThoughtStep
                description={via}
                icon={SearchIcon}
                key={part.toolCallId}
                label={`${running ? "Searching" : "Searched"} for “${query}”`}
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

          // fetch_page
          const url = String(input.url ?? "");
          const title = (output as FetchOutput | undefined)?.title;
          return (
            <ChainOfThoughtStep
              description={title}
              icon={GlobeIcon}
              key={part.toolCallId}
              label={`${running ? "Fetching" : "Fetched"} ${url ? safeHostname(url) : "page"}`}
              status={status}
            />
          );
        })}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}
