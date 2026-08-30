import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsSummary } from "@/components/settings/settings-summary";

// Matches SettingsSnapshot from settings-view.tsx (real field names)
const mockSettings = {
  ai: {
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4o",
    apiKeyConfigured: true,
  },
  embedding: {
    provider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    apiKeyConfigured: true,
    dimensions: 1536,
    chunkSize: 2000,
    chunkOverlap: 200,
    fallback: "local",
  },
  database: {
    engine: "SQLite",
    driver: "node:sqlite3",
    features: ["JSON", "FTS5", "Vector"],
    path: "/home/user/.yggdrasil/data.db",
    sizeBytes: 10485760,
    chatCount: 42,
    messageCount: 1234,
    memories: { episodic: 10, semantic: 5, working: 3 },
    queue: { pending: 0, completed: 100, failed: 2 },
  },
  tools: [
    { name: "web_search", description: "Search the web", configured: true, requires: null },
    { name: "calculator", description: "Math", configured: true, requires: null },
  ],
  webSearch: {
    providers: [
      { kind: "exa", enabled: true, ready: true, coolingDown: false },
      { kind: "firecrawl", enabled: false, ready: false, coolingDown: false },
    ],
    chain: ["exa"],
  },
  about: { name: "Yggdrasil", version: "1.0.0", stack: "Next.js + Fastify" },
  store: {
    providers: [],
    embedding: {},
  },
};

describe("SettingsSummary", () => {
  it("shows an AI Provider overview when the provider tab is active", () => {
    render(
      <SettingsSummary
        tab="provider"
        settings={mockSettings}
        providers={[{ id: "p1", kind: "ollama", name: "Ollama", baseUrl: "http://localhost:11434" }]}
      />
    );
    expect(screen.getByTestId("summary-provider")).toBeInTheDocument();
    expect(screen.getByText("1 AI provider configured.")).toBeInTheDocument();
  });

  it.each(["general", "embedding", "database", "tools", "about"])(
    "renders a summary for the %s tab",
    (tab) => {
      render(
        <SettingsSummary
          tab={tab}
          settings={mockSettings}
          providers={[]}
        />
      );
      expect(screen.getByTestId(`summary-${tab}`)).toBeInTheDocument();
    }
  );

  it("shows embedding provider and model for embedding tab", () => {
    render(
      <SettingsSummary
        tab="embedding"
        settings={mockSettings}
        providers={[]}
      />
    );
    expect(screen.getByText('Embedding provider: openai-compatible using model "text-embedding-3-small".')).toBeInTheDocument();
  });

  it("shows database engine and size for database tab", () => {
    render(
      <SettingsSummary
        tab="database"
        settings={mockSettings}
        providers={[]}
      />
    );
    expect(screen.getByText("SQLite engine, 10 MB — 42 chats, 1234 messages.")).toBeInTheDocument();
  });

  it("shows tools count and web search chain for tools tab", () => {
    render(
      <SettingsSummary
        tab="tools"
        settings={mockSettings}
        providers={[]}
      />
    );
    expect(screen.getByText("2 tools available, web search: exa.")).toBeInTheDocument();
  });

  it("shows version and stack for about tab", () => {
    render(
      <SettingsSummary
        tab="about"
        settings={mockSettings}
        providers={[]}
      />
    );
    expect(screen.getByText("Version 1.0.0, stack Next.js + Fastify.")).toBeInTheDocument();
  });

  it("renders gracefully when settings is null", () => {
    render(
      <SettingsSummary
        tab="database"
        settings={null}
        providers={[]}
      />
    );
    expect(screen.getByTestId("summary-database")).toBeInTheDocument();
    expect(screen.getByText("No database information available.")).toBeInTheDocument();
  });
});