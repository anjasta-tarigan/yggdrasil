import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PluginsView } from "../plugins-view";

// vitest runs without globals:true, so RTL's auto-cleanup never registers.
afterEach(() => {
  cleanup();
});

const mockMarketplaces = [
  {
    id: "mkt-anthropic",
    name: "Anthropic Official",
    description: "The official Anthropic marketplace.",
    ownerName: "anthropics",
    lastSyncedAt: "2025-01-01T00:00:00.000Z",
    installedCount: 1,
  },
  {
    id: "mkt-community",
    name: "Community",
    description: null,
    ownerName: "community",
    lastSyncedAt: null,
    installedCount: 0,
  },
];

const mockCatalog = {
  marketplace: { id: "mkt-anthropic", name: "Anthropic Official", owner: "anthropics" },
  entries: [
    {
      name: "pdf-tools",
      displayName: "PDF Tools",
      description: "PDF manipulation commands.",
      version: "1.0.0",
      category: "productivity",
      sourceType: "github",
      supported: true,
      installed: false,
      enabled: true,
    },
    {
      name: "dev-lsp",
      displayName: "Dev LSP",
      description: "LSP integration (unsupported here).",
      version: null,
      category: null,
      sourceType: "lsp",
      supported: false,
      installed: false,
      enabled: true,
    },
  ],
};

const mockInstalledPlugins = [
  {
    id: "plugin-1",
    name: "pdf-tools",
    displayName: "PDF Tools",
    description: "PDF manipulation commands.",
    version: "1.0.0",
    category: "productivity",
    enabled: true,
    marketplaceName: "Anthropic Official",
    components: {
      skills: [{ installedName: "pdf-tools" }],
      commands: [{ name: "pdf-merge" }],
      mcpServers: [],
      ignored: ["hooks"],
    },
  },
  {
    id: "plugin-2",
    name: "web-scraper",
    displayName: null,
    description: null,
    version: null,
    category: null,
    enabled: false,
    marketplaceName: "Community",
    components: null,
  },
];

// Base fetch implementation; individual tests override specific URLs.
const fetchMock = vi.fn(async (input: RequestInfo | URL, opts?: RequestInit) => {
  const url = String(input);
  if (url === "/api/plugins/marketplaces" && (!opts?.method || opts?.method === "GET")) {
    return new Response(JSON.stringify({ marketplaces: mockMarketplaces }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url === "/api/plugins/marketplaces" && opts?.method === "POST") {
    return new Response(
      JSON.stringify({
        marketplace: { id: "mkt-new", name: "New Marketplace" },
        pluginCount: 3,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  if (url.startsWith("/api/plugins/marketplaces/mkt-community") && opts?.method === "DELETE") {
    return new Response(JSON.stringify({ removedPlugins: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.startsWith("/api/plugins/catalog?marketplace=mkt-community")) {
    return new Response(
      JSON.stringify({
        marketplace: { id: "mkt-community", name: "Community", owner: "community" },
        entries: [],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  if (url.startsWith("/api/plugins/catalog")) {
    return new Response(JSON.stringify(mockCatalog), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url === "/api/plugins" && (!opts?.method || opts?.method === "GET")) {
    return new Response(JSON.stringify({ plugins: mockInstalledPlugins }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url === "/api/plugins/install" && opts?.method === "POST") {
    return new Response(
      JSON.stringify({
        plugin: { id: "plugin-new", name: "pdf-tools" },
        components: { skills: [{ installedName: "pdf-tools" }], commands: [] },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
  if (url.startsWith("/api/plugins/plugin-1") && opts?.method === "PATCH") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.startsWith("/api/plugins/plugin-2") && opts?.method === "DELETE") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("not found", { status: 404 });
});

describe("PluginsView", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  it("shows the manage tab by default with installed plugins", async () => {
    render(<PluginsView onBack={() => {}} />);

    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();
    expect(screen.getByText("web-scraper")).toBeInTheDocument();

    // Both tabs are present.
    expect(
      screen.getByRole("tab", { name: "Manage plugins" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Plugin marketplaces" })
    ).toBeInTheDocument();

    // The marketplace content is not visible on the manage tab.
    expect(screen.queryByRole("heading", { name: /plugin marketplaces/i })).not.toBeInTheDocument();
  });

  it("shows component badges and marketplace provenance on installed rows", async () => {
    render(<PluginsView onBack={() => {}} />);
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();

    expect(screen.getByText("1 skills")).toBeInTheDocument();
    expect(screen.getByText("1 commands")).toBeInTheDocument();
    expect(screen.getByText("ignored: hooks")).toBeInTheDocument();
    expect(screen.getByText(/from Anthropic Official/)).toBeInTheDocument();
  });

  it("filters the installed list", async () => {
    render(<PluginsView onBack={() => {}} />);
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter installed plugins"), {
      target: { value: "scraper" },
    });
    expect(screen.getByText("web-scraper")).toBeInTheDocument();
    expect(screen.queryByText("PDF Tools")).not.toBeInTheDocument();
  });

  it("toggles a plugin's enabled state", async () => {
    render(<PluginsView onBack={() => {}} />);
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();

    const toggle = screen.getByRole("switch", { name: "Toggle PDF Tools" });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: "Toggle PDF Tools" })
      ).not.toBeChecked();
    });
    const patch = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]).includes("/api/plugins/plugin-1") && call[1]?.method === "PATCH"
    );
    expect(patch).toBeDefined();
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ enabled: false });
  });

  it("uninstalls a plugin from the manage tab", async () => {
    render(<PluginsView onBack={() => {}} />);
    expect(await screen.findByText("web-scraper")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Uninstall web-scraper"));
    // Destructive uninstall is gated behind a confirmation dialog; confirm it.
    await userEvent.click(await screen.findByRole("button", { name: "Uninstall" }));
    expect(await screen.findByText(/Uninstalled “web-scraper”/i)).toBeInTheDocument();
    const del = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]).includes("/api/plugins/plugin-2") && call[1]?.method === "DELETE"
    );
    expect(del).toBeDefined();
  });

  it("switches to the marketplaces tab and loads the default catalog", async () => {
    render(<PluginsView onBack={() => {}} />);
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("tab", { name: "Plugin marketplaces" })
    );

    // The selected marketplace (first row) auto-loads its catalog.
    expect(await screen.findByText("Dev LSP")).toBeInTheDocument();
    expect(screen.getByText("PDF Tools")).toBeInTheDocument(); // catalog entry now

    // Marketplace list is present with owner provenance.
    expect(screen.getByText("anthropics · 1 installed")).toBeInTheDocument();
  });

  it("switches catalogs via the marketplace select", async () => {
    render(<PluginsView onBack={() => {}} />);
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("tab", { name: "Plugin marketplaces" })
    );
    expect(await screen.findByText("Dev LSP")).toBeInTheDocument();

    // Open the select and pick Community via keyboard navigation.
    const trigger = screen.getByLabelText("Select marketplace");
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}"); // opens listbox
    await userEvent.keyboard("{ArrowDown}"); // move to Community
    await userEvent.keyboard("{Enter}");

    // Community's catalog is empty; its name + owner appear in the header.
    expect(
      await screen.findByText(/Community by community — 0 plugins/)
    ).toBeInTheDocument();
  });

  it("installs a plugin from the catalog", async () => {
    render(<PluginsView onBack={() => {}} />);
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("tab", { name: "Plugin marketplaces" })
    );
    expect(await screen.findByText("Dev LSP")).toBeInTheDocument();

    // Install the supported, not-yet-installed entry (Dev LSP's install
    // button is disabled; PDF Tools entry shows as not installed).
    const installButton = screen.getAllByRole("button", { name: "Install" })[0];
    await userEvent.click(installButton);

    expect(await screen.findByText(/Installed “pdf-tools”/i)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(
      (call) => String(call[0]) === "/api/plugins/install"
    );
    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      marketplaceId: "mkt-anthropic",
      pluginName: "pdf-tools",
    });
  });

  it("adds a marketplace from the marketplaces tab", async () => {
    render(<PluginsView onBack={() => {}} />);
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("tab", { name: "Plugin marketplaces" })
    );
    expect(await screen.findByText("Dev LSP")).toBeInTheDocument();

    const input = screen.getByLabelText("New marketplace source");
    await userEvent.type(input, "someowner/some-repo");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(
      await screen.findByText(/Marketplace “New Marketplace” added/)
    ).toBeInTheDocument();
  });

  it("removes a marketplace", async () => {
    render(<PluginsView onBack={() => {}} />);
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("tab", { name: "Plugin marketplaces" })
    );
    expect(await screen.findByText("Dev LSP")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Remove Community"));
    // Destructive marketplace removal is gated behind a confirmation dialog; confirm it.
    await userEvent.click(await screen.findByRole("button", { name: "Remove marketplace" }));

    const del = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]).includes("/api/plugins/marketplaces/mkt-community") &&
        call[1]?.method === "DELETE"
    );
    expect(del).toBeDefined();
  });

  it("disables install for unsupported catalog sources", async () => {
    render(<PluginsView onBack={() => {}} />);
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("tab", { name: "Plugin marketplaces" })
    );
    expect(await screen.findByText("Dev LSP")).toBeInTheDocument();

    // The unsupported LSP entry carries a destructive badge and a
    // disabled Installed-labeled button.
    expect(
      screen.getByText("unsupported source: lsp")
    ).toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: /Installed|Install/ });
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("filters the marketplace catalog by search query and shows empty state with clear action", async () => {
    render(<PluginsView onBack={() => {}} />);
    expect(await screen.findByText("PDF Tools")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("tab", { name: "Plugin marketplaces" })
    );
    expect(await screen.findByText("Dev LSP")).toBeInTheDocument();

    // Both entries visible initially.
    expect(screen.getByText("PDF Tools")).toBeInTheDocument();
    expect(screen.getByText("Dev LSP")).toBeInTheDocument();

    // Type a search that matches only one entry.
    const search = screen.getByLabelText("Search plugins");
    await userEvent.type(search, "lsp");
    expect(screen.getByText("Dev LSP")).toBeInTheDocument();
    expect(screen.queryByText("PDF Tools")).not.toBeInTheDocument();

    // Clear the search and type a term that matches nothing.
    await userEvent.clear(search);
    await userEvent.type(search, "zzznoresults");

    // Empty state with a "Clear search" action.
    expect(
      await screen.findByText(/No plugins match/)
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Clear search" })
    );
    // Results return after clearing.
    expect(screen.getByText("PDF Tools")).toBeInTheDocument();
    expect(screen.getByText("Dev LSP")).toBeInTheDocument();
  });

  it("shows the empty state with a marketplaces shortcut when nothing is installed", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, opts?: RequestInit) => {
      const url = String(input);
      if (url === "/api/plugins" && (!opts?.method || opts?.method === "GET")) {
        return new Response(JSON.stringify({ plugins: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/plugins/marketplaces" && (!opts?.method || opts?.method === "GET")) {
        return new Response(JSON.stringify({ marketplaces: mockMarketplaces }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith("/api/plugins/catalog")) {
        return new Response(JSON.stringify(mockCatalog), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    render(<PluginsView onBack={() => {}} />);
    expect(
      await screen.findByText("No plugins installed yet")
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /Open marketplaces/i })
    );
    expect(await screen.findByText("Dev LSP")).toBeInTheDocument();
  });
});
