import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import {
  ResearchTrail,
  extractSearchResults,
  researchToolInfo,
} from "@/components/chat/ResearchTrail";
import type { DynamicToolUIPart } from "ai";

describe("researchToolInfo", () => {
  beforeEach(() => {
    cleanup();
  });

  it("classifies builtin research tools exactly", () => {
    expect(researchToolInfo("web_search")).toEqual({ base: "web_search" });
    expect(researchToolInfo("web_fetch")).toEqual({ base: "web_fetch" });
    expect(researchToolInfo("fetch_page")).toEqual({ base: "fetch_page" });
  });

  it("classifies MCP-slugged duplicates by their suffix", () => {
    expect(researchToolInfo("parallel-search__web_search")).toEqual({
      base: "web_search",
      mcpServer: "parallel-search",
    });
    expect(researchToolInfo("acme_search__fetch_page")).toEqual({
      base: "fetch_page",
      mcpServer: "acme_search",
    });
  });

  it("returns undefined for non-research and non-research MCP tools", () => {
    expect(researchToolInfo("bash")).toBeUndefined();
    expect(researchToolInfo("parallel-search__get_stock")).toBeUndefined();
    expect(researchToolInfo("web_searchx")).toBeUndefined();
    // Subagent delegation tools use a single underscore, not the MCP
    // double-underscore separator — never classified as research.
    expect(researchToolInfo("delegate_researcher")).toBeUndefined();
  });
});

describe("extractSearchResults", () => {
  it("normalizes builtin results rows", () => {
    const out = extractSearchResults({
      provider: "exa",
      results: [{ title: "Drizzle", url: "https://drizzle.team" }],
    });
    expect(out).toEqual([
      { title: "Drizzle", url: "https://drizzle.team", snippet: undefined },
    ]);
  });

  it("normalizes Parallel-style excerpts with text fields", () => {
    const out = extractSearchResults({
      excerpts: [
        { url: "https://a.dev", text: "dense excerpt" },
        { url: "https://b.dev", excerpt: "alt field" },
        { title: "No URL", text: "dropped" },
      ],
    });
    expect(out).toEqual([
      { title: "a.dev", url: "https://a.dev", snippet: "dense excerpt" },
      { title: "b.dev", url: "https://b.dev", snippet: "alt field" },
    ]);
  });

  it("returns undefined when nothing is usable", () => {
    expect(extractSearchResults(undefined)).toBeUndefined();
    expect(extractSearchResults({ results: [] })).toBeUndefined();
    expect(extractSearchResults({ excerpts: [] })).toBeUndefined();
    expect(extractSearchResults({ excerpts: [{ text: "no url" }] })).toBeUndefined();
  });
});

describe("ResearchTrail (MCP steps)", () => {
  beforeEach(() => {
    cleanup();
  });

  const mcpSearchPart: DynamicToolUIPart = {
    type: "dynamic-tool",
    state: "output-available",
    toolCallId: "call-1",
    toolName: "parallel-search__web_search",
    input: { objective: "research", search_queries: ["drizzle orm", "sqlite"] },
    output: {
      excerpts: [
        { url: "https://drizzle.team", text: "Type-safe SQL" },
        { url: "https://sqlite.org", text: "Small DB" },
      ],
    },
  };

  it("renders MCP search steps with a Calling MCP description", () => {
    render(<ResearchTrail parts={[mcpSearchPart]} />);
    expect(screen.getByText("Research — 1 step")).toBeInTheDocument();
    // Completed history mounts folded — expand to inspect the steps.
    fireEvent.click(screen.getByText("Research — 1 step"));
    // "Called MCP Parallel Search" (completed state).
    expect(screen.getByText("Called MCP Parallel Search")).toBeInTheDocument();
    expect(
      screen.getByText(/Searched for .drizzle orm, sqlite./)
    ).toBeInTheDocument();
    // Excerpt hosts surface as search-result badges.
    expect(screen.getByText("drizzle.team")).toBeInTheDocument();
    expect(screen.getByText("sqlite.org")).toBeInTheDocument();
  });

  it("labels a running MCP call as Calling MCP", () => {
    const running: DynamicToolUIPart = {
      type: "dynamic-tool",
      state: "input-available",
      toolCallId: "call-3",
      toolName: "parallel-search__web_search",
      input: { objective: "research", search_queries: ["drizzle orm"] },
    };
    render(<ResearchTrail parts={[running]} />);
    expect(screen.getByText("Calling MCP Parallel Search")).toBeInTheDocument();
    expect(screen.getByText(/Searching for .drizzle orm./)).toBeInTheDocument();
  });

  it("renders a frozen approval-requested step as pending, not complete", () => {
    // Historical chats can carry a research tool part stuck in
    // approval-requested (interrupted stream). The trail must not
    // present it as a finished step.
    const frozen: DynamicToolUIPart = {
      type: "dynamic-tool",
      state: "approval-requested",
      toolCallId: "call-4",
      toolName: "parallel-search__web_search",
      input: { objective: "research", search_queries: ["gold price"] },
      approval: {
        id: "approval-1",
        isAutomatic: false,
        signature: "sig",
      },
    };
    render(<ResearchTrail parts={[frozen]} />);
    expect(
      screen.getByText(/Search awaiting approval for .gold price./)
    ).toBeInTheDocument();
  });

  it("keeps the builtin provider description for builtin searches", () => {
    const builtinPart: DynamicToolUIPart = {
      type: "dynamic-tool",
      state: "output-available",
      toolCallId: "call-2",
      toolName: "web_search",
      input: { query: "vitest" },
      output: {
        provider: "exa",
        results: [{ title: "Vitest", url: "https://vitest.dev" }],
      },
    };
    render(<ResearchTrail parts={[builtinPart]} />);
    expect(screen.getByText("Research — 1 step")).toBeInTheDocument();
    // Completed history mounts folded — expand to inspect the steps.
    fireEvent.click(screen.getByText("Research — 1 step"));
    expect(screen.getByText("via exa")).toBeInTheDocument();
    expect(screen.getByText("vitest.dev")).toBeInTheDocument();
    expect(screen.queryByText(/MCP/)).not.toBeInTheDocument();
  });
});

describe("ResearchTrail auto-close (auto-minimize when complete)", () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const completedSearch: DynamicToolUIPart = {
    type: "dynamic-tool",
    state: "output-available",
    toolCallId: "call-done",
    toolName: "web_search",
    input: { query: "vitest" },
    output: {
      provider: "exa",
      results: [{ title: "Vitest", url: "https://vitest.dev" }],
    },
  };
  const runningSearch: DynamicToolUIPart = {
    type: "dynamic-tool",
    state: "input-available",
    toolCallId: "call-live",
    toolName: "web_search",
    input: { query: "react testing library" },
  };

  /** Advance virtual time past the auto-close grace delay (act-flushed). */
  async function advancePastDelay() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1010);
    });
  }

  it("mounts folded for a fully completed historical trail", () => {
    // History reload: no open-then-flash-fold — the trail starts
    // minimized and the user can expand on demand.
    render(<ResearchTrail parts={[completedSearch]} />);
    expect(screen.getByText("Research — 1 step")).toBeInTheDocument();
    expect(screen.queryByText("Searched for “vitest”")).toBeNull();
  });

  it("mounts open and stays open while a search is running", () => {
    render(<ResearchTrail parts={[completedSearch, runningSearch]} />);
    expect(
      screen.getByText(/Searching for .react testing library./)
    ).toBeInTheDocument();
  });

  it("folds after the grace delay once every search completes", async () => {
    const { rerender } = render(
      <ResearchTrail parts={[completedSearch, runningSearch]} />
    );
    expect(screen.getByText(/Searching for .react testing library./)).toBeInTheDocument();

    // The running search resolves.
    const resolved: DynamicToolUIPart = {
      ...runningSearch,
      state: "output-available",
      output: completedSearch.output,
    };
    rerender(<ResearchTrail parts={[completedSearch, resolved]} />);
    expect(screen.getByText(/Searched for .react testing library./)).toBeInTheDocument();

    await advancePastDelay();
    expect(screen.queryByText(/Searched for .react testing library./)).toBeNull();
  });

  it("keeps the trail open for a frozen approval-requested part", async () => {
    // Interrupted stream: the awaiting part keeps the trail open — an
    // honest "process not finished" signal rather than folding it away.
    const frozen: DynamicToolUIPart = {
      type: "dynamic-tool",
      state: "approval-requested",
      toolCallId: "call-frozen",
      toolName: "web_search",
      input: { query: "gold price" },
      approval: { id: "approval-1", isAutomatic: false, signature: "sig" },
    };
    render(<ResearchTrail parts={[completedSearch, frozen]} />);
    expect(
      screen.getByText(/Search awaiting approval for .gold price./)
    ).toBeInTheDocument();

    await advancePastDelay();
    expect(
      screen.getByText(/Search awaiting approval for .gold price./)
    ).toBeInTheDocument();
  });
});
