import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsSummary } from "@/components/settings/settings-summary";
import type { ProviderConfig } from "@/lib/settings";

describe("SettingsSummary", () => {
  const mockProviders: ProviderConfig[] = [
    { id: "p1", name: "OpenAI", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1" },
    { id: "p2", name: "Ollama", kind: "ollama", baseUrl: "http://localhost:11434/v1" },
  ];

  const mockSettings = {
    embedding: { provider: "ollama", model: "nomic-embed-text" },
    database: {
      engine: "SQLite",
      features: ["WAL", "FTS5"],
      chatCount: 3,
      messageCount: 42,
    },
    tools: [
      { name: "web_search", description: "Search", configured: true, requires: null },
      { name: "web_fetch", description: "Fetch", configured: true, requires: "FIRECRAWL_API_KEY" },
      { name: "other", description: "Other", configured: false, requires: "SOME_KEY" },
    ],
    webSearch: { chain: ["exa", "firecrawl"] },
    about: { name: "Yggdrasil", version: "0.1.0", stack: "Next.js" },
  };

  it("shows a summary for the general tab", () => {
    render(
      <SettingsSummary tab="general" settings={mockSettings} providers={mockProviders} />
    );
    expect(screen.getByTestId("summary-general")).toBeInTheDocument();
    expect(screen.getByText(/theme preference/i)).toBeInTheDocument();
  });

  it("shows provider count for the provider tab", () => {
    render(
      <SettingsSummary tab="provider" settings={mockSettings} providers={mockProviders} />
    );
    expect(screen.getByText(/2 AI providers added/i)).toBeInTheDocument();
  });

  it("shows embedding provider info", () => {
    render(
      <SettingsSummary tab="embedding" settings={mockSettings} providers={mockProviders} />
    );
    expect(screen.getByText(/ollama/)).toBeInTheDocument();
    expect(screen.getByText(/nomic-embed-text/)).toBeInTheDocument();
  });

  it("shows database engine info", () => {
    render(
      <SettingsSummary tab="database" settings={mockSettings} providers={mockProviders} />
    );
    expect(screen.getByText(/SQLite/)).toBeInTheDocument();
    expect(screen.getByText(/WAL, FTS5/)).toBeInTheDocument();
    expect(screen.getByText(/3 chat\(s\), 42 messages/)).toBeInTheDocument();
  });

  it("shows configured tool counts and the search chain", () => {
    render(
      <SettingsSummary tab="tools" settings={mockSettings} providers={mockProviders} />
    );
    expect(screen.getByText(/2\/3 assistant tool\(s\) configured/)).toBeInTheDocument();
    expect(screen.getByText(/exa → firecrawl/)).toBeInTheDocument();
  });

  it("shows about with name, version and stack", () => {
    render(
      <SettingsSummary tab="about" settings={mockSettings} providers={mockProviders} />
    );
    expect(screen.getByText(/Yggdrasil v0\.1\.0 — Next\.js/)).toBeInTheDocument();
  });

  it("handles missing settings gracefully", () => {
    render(
      <SettingsSummary tab="embedding" settings={null} providers={[]} />
    );
    expect(screen.getByText(/none/)).toBeInTheDocument();
    expect(screen.getByText(/not configured yet/)).toBeInTheDocument();
  });
});