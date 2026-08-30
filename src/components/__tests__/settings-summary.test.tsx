import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsSummary } from "@/components/settings/settings-summary";

describe("SettingsSummary", () => {
  const mockSettings = {
    embedding: { provider: "ollama", model: "nomic-embed-text" },
    database: { engine: "SQLite", features: ["WAL", "FTS5"] },
    tools: { webSearch: ["exa", "firecrawl"], skills: ["brainstorming"] },
  };

  const mockProviders = [
    { id: "p1", name: "OpenAI", kind: "openai-compatible" },
    { id: "p2", name: "Ollama", kind: "ollama" },
  ];

  it("shows a summary for the general tab", () => {
    render(
      <SettingsSummary
        tab="general"
        settings={mockSettings}
        providers={mockProviders}
      />
    );
    expect(screen.getByTestId("summary-general")).toBeInTheDocument();
    expect(screen.getByText(/general assistant preferences/i)).toBeInTheDocument();
  });

  it("shows provider count for the provider tab", () => {
    render(
      <SettingsSummary
        tab="provider"
        settings={mockSettings}
        providers={mockProviders}
      />
    );
    expect(screen.getByText(/2 AI providers configured/)).toBeInTheDocument();
  });

  it("shows embedding provider info", () => {
    render(
      <SettingsSummary
        tab="embedding"
        settings={mockSettings}
        providers={mockProviders}
      />
    );
    expect(screen.getByText(/ollama/)).toBeInTheDocument();
    expect(screen.getByText(/nomic-embed-text/)).toBeInTheDocument();
  });

  it("shows database engine info", () => {
    render(
      <SettingsSummary
        tab="database"
        settings={mockSettings}
        providers={mockProviders}
      />
    );
    expect(screen.getByText(/SQLite/)).toBeInTheDocument();
    expect(screen.getByText(/WAL, FTS5/)).toBeInTheDocument();
  });

  it("shows tools enabled counts", () => {
    render(
      <SettingsSummary
        tab="tools"
        settings={mockSettings}
        providers={mockProviders}
      />
    );
    expect(screen.getByText(/2 web search provider/)).toBeInTheDocument();
    expect(screen.getByText(/1 skill/)).toBeInTheDocument();
  });

  it("shows about with a GitHub link", () => {
    render(
      <SettingsSummary
        tab="about"
        settings={mockSettings}
        providers={mockProviders}
      />
    );
    expect(screen.getByText(/Yggdrasil v0.1.0/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /GitHub/i });
    expect(link).toHaveAttribute("href", "https://github.com/anjasta-tarigan/yggdrasil");
  });

  it("handles missing settings gracefully", () => {
    render(
      <SettingsSummary
        tab="embedding"
        settings={null}
        providers={[]}
      />
    );
    expect(screen.getByText(/none/)).toBeInTheDocument();
  });
});