import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { McpView } from "../mcp-view";

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

// Minimal marketplace response — no community entries.
const mockMarketplace = {
  presets: [
    {
      id: "mcp-brave-search",
      name: "Brave Search",
      description: "Search the web using Brave's search API.",
      category: "web",
      transport: "stdio",
      command: "npx -y @modelcontextprotocol/server-brave-search@0.6.2",
      isCommunity: false,
      envVars: [
        {
          name: "BRAVE_API_KEY",
          description: "A Brave Search API key",
          required: true,
        },
      ],
    },
    {
      id: "mcp-fetch",
      name: "Fetch",
      description: "Fetch content from URLs.",
      category: "web",
      transport: "stdio",
      command: "npx -y @modelcontextprotocol/server-fetch@0.6.2",
      isCommunity: false,
      envVars: [],
    },
    {
      id: "mcp-postgres",
      name: "PostgreSQL",
      description: "Connect to a PostgreSQL database.",
      category: "database",
      transport: "stdio",
      command: "npx -y @modelcontextprotocol/server-postgres@0.6.2",
      isCommunity: false,
      envVars: [
        {
          name: "DATABASE_URL",
          description: "PostgreSQL connection string",
          required: true,
        },
      ],
    },
  ],
  community: [],
  hasCommunity: false,
};

// Mock snapshot + test result responses.
const mockSnapshotResponse = {
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
        tools: [{ name: "brave_search", description: "Web search via Brave" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  return new Response("not found", { status: 404 });
});

describe("McpView", () => {
  beforeEach(() => {
    fetchMock.mockClear();
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

  it("switches to the Marketplace tab and displays preset cards", async () => {
    render(<McpView onBack={() => {}} />);

    await screen.findByRole("tab", { name: "Marketplace" });
    await userEvent.click(screen.getByRole("tab", { name: "Marketplace" }));

    // Presets render as cards.
    expect(await screen.findByText("Brave Search")).toBeInTheDocument();
    expect(screen.getByText("Fetch")).toBeInTheDocument();

    // Each preset has an Install button.
    const installButtons = screen.getAllByRole("button", { name: /Install/i });
    expect(installButtons.length).toBeGreaterThanOrEqual(2);
  });

  it("install button on a preset with required envVars opens the install dialog", async () => {
    render(<McpView onBack={() => {}} />);

    await screen.findByRole("tab", { name: "Marketplace" });
    await userEvent.click(screen.getByRole("tab", { name: "Marketplace" }));

    // Wait for presets, then click Install on Brave Search.
    expect(await screen.findByText("Brave Search")).toBeInTheDocument();
    const installButtons = screen.getAllByRole("button", { name: /^Install$/ });
    const braveInstall = installButtons.find(
      (btn) => btn.closest('[data-testid="preset-card"]')?.textContent?.includes("Brave Search")
    );
    expect(braveInstall).toBeDefined();
    await userEvent.click(braveInstall!);

    // The install dialog opens with a prompt for BRAVE_API_KEY.
    expect(
      await screen.findByText(/Configure Brave Search/i, {}, { timeout: 2000 })
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

    expect(await screen.findByText("Fetch")).toBeInTheDocument();
    const installButtons = screen.getAllByRole("button", { name: /^Install$/ });
    const fetchInstall = installButtons.find(
      (btn) => btn.closest('[data-testid="preset-card"]')?.textContent?.includes("Fetch")
    );
    expect(fetchInstall).toBeDefined();
    await userEvent.click(fetchInstall!);

    // No dialog — should proceed to test directly.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/mcp/test"),
        expect.objectContaining({ method: "POST" })
      );
    });
  });
  });

  it("switches to Configured Servers tab after install completes", async () => {
    render(<McpView onBack={() => {}} />);

    await screen.findByRole("tab", { name: "Marketplace" });
    await userEvent.click(screen.getByRole("tab", { name: "Marketplace" }));

    // Install Fetch (no env vars) — completes and switches tab.
    expect(await screen.findByText("Fetch")).toBeInTheDocument();
    const installButtons = screen.getAllByRole("button", { name: /^Install$/ });
    const fetchInstall = installButtons.find(
      (btn) => btn.closest('[data-testid="preset-card"]')?.textContent?.includes("Fetch")
    );
    await userEvent.click(fetchInstall!);

    await waitFor(() => {
      expect(
        screen.getByRole("tab", { name: "Configured Servers" })
      ).toHaveAttribute("data-state", "active");
    });
});
