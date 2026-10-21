import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpView } from "../mcp-view";
import {
  getMcpServers,
  saveMcpServers,
  type McpServerConfig,
} from "@/lib/settings";

// Mock @/lib/settings so no server writes happen during tests.
vi.mock("@/lib/settings", () => ({
  getMcpServers: vi.fn(() => []),
  saveMcpServers: vi.fn(),
  addMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
  createMcpServerId: vi.fn(() => "mcp-test-id"),
}));

// Mock @/lib/ai/mcp/secrets so writeMcpSecret is a no-op.
vi.mock("@/lib/ai/mcp/secrets", () => ({
  writeMcpSecret: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

// Mock live Smithery response with verified and community items
const mockMarketplace = {
  servers: [
    {
      id: "smithery-context7",
      qualifiedName: "upstash/context7-mcp",
      name: "Context7",
      description: "Search the web and docs using Context7.",
      category: "web",
      transport: "http",
      deploymentUrl: "https://context7.run.tools",
      verified: true,
      useCount: 1500,
      envVars: [
        {
          name: "BRAVE_API_KEY",
          description: "An API key for search",
          required: true,
        },
      ],
    },
    {
      id: "smithery-news",
      qualifiedName: "theagenttimes/news",
      name: "Agent News",
      description: "Fetch AI agent news and citations.",
      category: "web",
      transport: "http",
      deploymentUrl: "https://news.run.tools",
      verified: true,
      useCount: 2200,
      envVars: [],
    },
  ],
  total: 2,
  source: "smithery.ai",
  verifiedOnly: true,
};

const initialServer = {
  id: "mcp-web",
  name: "Web Provider",
  transport: "http" as const,
  enabled: true,
  url: "https://web.example/mcp",
};

// Mock snapshot + test result responses.
const mockSnapshotResponse: {
  servers: McpServerConfig[];
  status: Record<string, unknown>;
  baselines: Record<string, unknown>;
} = {
  servers: [],
  status: {},
  baselines: {},
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, opts?: RequestInit) => {
  const url = String(input);
  if (url === "/api/mcp" && (!opts?.method || opts?.method === "GET")) {
    return new Response(JSON.stringify(mockSnapshotResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.startsWith("/api/mcp/marketplace/detail") && (!opts?.method || opts?.method === "GET")) {
    if (url.includes("news")) {
      return new Response(
        JSON.stringify({
          qualifiedName: "theagenttimes/news",
          displayName: "Agent News",
          description: "Fetch AI agent news and citations.",
          transport: "http",
          url: "https://news.run.tools",
          configSchema: {},
          verified: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        qualifiedName: "upstash/context7-mcp",
        displayName: "Context7",
        description: "Search the web and docs using Context7.",
        transport: "stdio",
        command: "npx -y @upstash/context7-mcp@latest",
        configSchema: {
          properties: {
            BRAVE_API_KEY: {
              type: "string",
              description: "An API key for search",
              required: true,
            },
          },
          required: ["BRAVE_API_KEY"],
        },
        verified: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  if (url.startsWith("/api/mcp/marketplace") && (!opts?.method || opts?.method === "GET")) {
    return new Response(JSON.stringify(mockMarketplace), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url === "/api/mcp/test" && opts?.method === "POST") {
    return new Response(
      JSON.stringify({
        ok: true,
        serverName: "Brave Search",
        serverVersion: "0.6.2",
        tools: [
          { name: "web_search", description: "Search the web" },
          { name: "web_fetch", description: "Fetch a page" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  return new Response("not found", { status: 404 });
});

describe("McpView", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.mocked(getMcpServers).mockReturnValue([]);
    vi.mocked(saveMcpServers).mockReset().mockImplementation(async (servers) => {
      mockSnapshotResponse.servers = servers;
      vi.mocked(getMcpServers).mockReturnValue(servers);
    });
    mockSnapshotResponse.servers = [];
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  it("renders both tabs: Configured Servers and Marketplace", async () => {
    render(<McpView onBack={() => {}} />);

    // Default tab is "configured".
    expect(
      await screen.findByRole("tab", { name: "Configured Servers" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Marketplace" })
    ).toBeInTheDocument();

    // Marketplace is not active by default.
    expect(screen.queryByText("Install Brave Search")).not.toBeInTheDocument();
  });

  it("selects MCP web search and fetch independently as primary providers", async () => {
    vi.mocked(getMcpServers).mockReturnValue([initialServer]);
    mockSnapshotResponse.servers = [initialServer];
    render(<McpView onBack={() => {}} />);

    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    const search = await screen.findByRole("switch", {
      name: "Use Web Provider as primary web_search",
    });
    const fetch = screen.getByRole("switch", {
      name: "Use Web Provider as primary web_fetch",
    });
    await userEvent.click(search);

    await waitFor(() => expect(search).toHaveAttribute("aria-checked", "true"));
    expect(fetch).toHaveAttribute("aria-checked", "false");
    await userEvent.click(fetch);
    await waitFor(() => expect(fetch).toHaveAttribute("aria-checked", "true"));
    expect(search).toHaveAttribute("aria-checked", "true");
    expect(saveMcpServers).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: "mcp-web",
        primaryCapabilities: ["web_search", "web_fetch"],
      }),
    ]);
  });

  it("switches to the Marketplace tab and displays preset cards", async () => {
    render(<McpView onBack={() => {}} />);

    await screen.findByRole("tab", { name: "Marketplace" });
    await userEvent.click(screen.getByRole("tab", { name: "Marketplace" }));

    // Presets render as cards.
    expect(await screen.findByText("Context7")).toBeInTheDocument();
    expect(screen.getByText("Agent News")).toBeInTheDocument();

    // Each preset has an Install button.
    const installButtons = screen.getAllByRole("button", { name: /Install/i });
    expect(installButtons.length).toBeGreaterThanOrEqual(2);
  });

  it("install button on a preset with required envVars opens the install dialog", async () => {
    render(<McpView onBack={() => {}} />);

    await screen.findByRole("tab", { name: "Marketplace" });
    await userEvent.click(screen.getByRole("tab", { name: "Marketplace" }));

    // Wait for presets, then click Install on Context7.
    expect(await screen.findByText("Context7")).toBeInTheDocument();
    const installButtons = screen.getAllByRole("button", { name: /^Install$/ });
    const context7Install = installButtons.find(
      (btn) => btn.closest('[data-testid="preset-card"]')?.textContent?.includes("Context7")
    );
    expect(context7Install).toBeDefined();
    await userEvent.click(context7Install!);

    // The install dialog opens with a prompt for BRAVE_API_KEY.
    expect(
      await screen.findByText(/Configure Context7/i, {}, { timeout: 2000 })
    ).toBeInTheDocument();

    // Required env var input is present.
    expect(
      await screen.findByLabelText(/BRAVE_API_KEY/i)
    ).toBeInTheDocument();
  });

  it("install button on a preset with no required envVars installs directly", async () => {
    render(<McpView onBack={() => {}} />);

    await screen.findByRole("tab", { name: "Marketplace" });
    await userEvent.click(screen.getByRole("tab", { name: "Marketplace" }));

    expect(await screen.findByText("Agent News")).toBeInTheDocument();
    const installButtons = screen.getAllByRole("button", { name: /^Install$/ });
    const newsInstall = installButtons.find(
      (btn) => btn.closest('[data-testid="preset-card"]')?.textContent?.includes("Agent News")
    );
    expect(newsInstall).toBeDefined();
    await userEvent.click(newsInstall!);

    // No dialog — should proceed to test directly.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/mcp/test"),
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("switches to Configured Servers tab after install completes", async () => {
    render(<McpView onBack={() => {}} />);

    await screen.findByRole("tab", { name: "Marketplace" });
    await userEvent.click(screen.getByRole("tab", { name: "Marketplace" }));

    // Install Agent News (no env vars) — completes and switches tab.
    expect(await screen.findByText("Agent News")).toBeInTheDocument();
    const installButtons = screen.getAllByRole("button", { name: /^Install$/ });
    const newsInstall = installButtons.find(
      (btn) => btn.closest('[data-testid="preset-card"]')?.textContent?.includes("Agent News")
    );
    await userEvent.click(newsInstall!);

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: "Configured Servers" })
      ).toHaveAttribute("data-state", "active");
    });
  });
});
