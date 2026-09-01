import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatisticsView } from "../statistics-view";

// vitest runs without globals:true, so RTL's auto-cleanup never registers.
afterEach(() => {
  cleanup();
});

const mockStats = {
  collectedAt: "2025-06-01T12:00:00.000Z",
  device: {
    hostname: "yggdrasil-server",
    platform: "linux",
    arch: "x64",
    osRelease: "6.8.0",
    cpuModel: "AMD Ryzen 9",
    cpuCores: 12,
    nodeVersion: "v22.0.0",
    nextVersion: "16.3.2",
    processUptimeSeconds: 90061, // 1d 1h 1m
  },
  resources: {
    loadAverage: [0.5, 0.4, 0.3],
    memoryTotalBytes: 16 * 1024 ** 3,
    memoryFreeBytes: 8 * 1024 ** 3,
    processRssBytes: 200 * 1024 ** 2,
    processHeapUsedBytes: 100 * 1024 ** 2,
    processHeapTotalBytes: 160 * 1024 ** 2,
    diskTotalBytes: 500 * 1024 ** 3,
    diskFreeBytes: 250 * 1024 ** 3,
    databaseSizeBytes: 64 * 1024 ** 2,
  },
  gpu: null,
  services: {
    llm: {
      baseUrl: "http://localhost:11434",
      modelId: "llama3",
      status: "ok",
      latencyMs: 42,
    },
    embedding: { provider: "ollama", baseUrl: null, model: "nomic-embed" },
  },
  scheduler: {
    daemonRunning: true,
    queueRunnerRunning: false,
    cron: { maintenance: "*/5 * * * *" },
  },
  database: {
    chatCount: 12,
    messageCount: 3456,
    memories: { episodic: 100, semantic: 40, working: 5 },
    queue: { pending: 7, completed: 200, failed: 3 },
    cognitive: {
      daemonRunning: true,
      queueRunnerRunning: true,
      relations: 512,
      unembedded: { episodic: 2, semantic: 0 },
      lastRuns: [{ type: "dream", at: "2025-06-01T11:00:00.000Z" }],
      lastFailure: null,
    },
  },
};

const mockGraph = {
  nodes: [
    {
      id: "n1",
      label: "project-yggdrasil",
      type: "semantic",
      importance: 0.9,
      degree: 5,
      tags: ["yggdrasil"],
      accessCount: 3,
      createdAt: 1750000000000,
    },
    {
      id: "n2",
      label: "react-ui",
      type: "semantic",
      importance: 0.7,
      degree: 2,
      tags: [],
      accessCount: 0,
      createdAt: 1750000000000,
    },
    {
      id: "n3",
      label: "chat-about-skills",
      type: "episodic",
      importance: 0.5,
      degree: 1,
      tags: [],
      accessCount: 0,
      createdAt: 1750000000000,
    },
  ],
  edges: [
    { source: "n1", target: "n2", relationType: "associative", strength: 0.8 },
    { source: "n1", target: "n3", relationType: "consolidated_into", strength: 0.6 },
  ],
  truncated: false,
  stats: {
    semanticCount: 2,
    episodicCount: 1,
    relationCount: 2,
    byRelationType: { associative: 1, consolidated_into: 1 },
    topHubs: [{ id: "n1", label: "project-yggdrasil", degree: 5 }],
    topTags: [{ tag: "yggdrasil", count: 2 }],
  },
};

const mockLogs = {
  entries: [
    { id: 1, at: "2025-06-01T11:59:58.000Z", level: "info", scope: "chat", message: "Stream completed" },
    { id: 2, at: "2025-06-01T11:59:40.000Z", level: "warn", scope: "queue", message: "Retry scheduled" },
    { id: 3, at: "2025-06-01T11:59:10.000Z", level: "error", scope: "embedding", message: "Provider timeout" },
    { id: 4, at: "2025-06-01T11:58:00.000Z", level: "debug", scope: "daemon", message: "Tick" },
  ],
};

// Base fetch implementation; individual tests layer one-off overrides
// on top (mockImplementationOnce), which fall through to this. The
// logs endpoint honors the minLevel/search params the tab sends so
// filter flows behave like production.
const LOG_LEVEL_ORDER: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const baseFetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(String(input), "http://localhost");
  if (url.pathname === "/api/system/stats") {
    return new Response(JSON.stringify(mockStats), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.pathname === "/api/system/graph") {
    return new Response(JSON.stringify(mockGraph), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.pathname === "/api/system/logs") {
    const minLevel = url.searchParams.get("minLevel") ?? "debug";
    const search = (url.searchParams.get("search") ?? "").toLowerCase();
    const entries = mockLogs.entries.filter((e) => {
      if (LOG_LEVEL_ORDER[e.level] < LOG_LEVEL_ORDER[minLevel]) return false;
      if (
        search &&
        !e.message.toLowerCase().includes(search) &&
        !e.scope.toLowerCase().includes(search)
      ) {
        return false;
      }
      return true;
    });
    return new Response(JSON.stringify({ entries }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("not found", { status: 404 });
};

// The mocked global fetch: wraps baseFetch so tests can inspect calls
// (method, URL) and layer one-off overrides that fall through cleanly.
const fetchMock = vi.fn(baseFetch);

describe("StatisticsView", () => {
  beforeEach(() => {
    // Reset both call history AND any implementation a prior test
    // layered on (mockClear alone keeps overrides alive and pollutes
    // later tests in the same file).
    fetchMock.mockReset().mockImplementation(baseFetch);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  it("shows the overview tab by default with stat tiles and cards", async () => {
    render(<StatisticsView onBack={() => {}} />);

    // Hero tiles render: chats / messages / memories total / queue pending.
    // Tile values are the only tabular-nums <p> elements on the page.
    const tileValues = await waitFor(() => {
      const values = Array.from(
        document.querySelectorAll("p.tabular-nums")
      ).map((el) => el.textContent);
      expect(values).toEqual(["12", "3,456", "145", "7"]);
      return values;
    });

    // Cards render.
    expect(screen.getByText("yggdrasil-server")).toBeInTheDocument();
    expect(screen.getByText("Resource usage")).toBeInTheDocument();
    expect(screen.getByText("Services & scheduler")).toBeInTheDocument();
    expect(screen.getByText("Cognitive memory")).toBeInTheDocument();

    // Uptime formatted.
    expect(screen.getByText("1d 1h 1m")).toBeInTheDocument();

    // All three tabs are present.
    expect(screen.getByRole("tab", { name: "Overview" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Knowledge graph" })
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "System logs" })).toBeInTheDocument();
    expect(tileValues).toBeDefined();
  });

  it("shows skeleton tiles before the first sample lands", () => {
    // Hold the stats request open so the page stays in its loading state.
    let resolveStats: (value: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveStats = resolve;
        })
    );

    render(<StatisticsView onBack={() => {}} />);
    // Four skeleton tile bodies render (muted bars), and no live chip yet.
    expect(document.querySelectorAll("div.bg-muted, div.bg-muted\\/80").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Live ·/)).not.toBeInTheDocument();

    resolveStats(
      new Response(JSON.stringify(mockStats), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  it("shows a live timestamp chip once stats arrive", async () => {
    render(<StatisticsView onBack={() => {}} />);
    expect(await screen.findByText(/Live ·/)).toBeInTheDocument();
  });

  it("does not fetch the graph while the overview tab is active (lazy tabs)", async () => {
    render(<StatisticsView onBack={() => {}} />);
    await screen.findByText("yggdrasil-server");

    await waitFor(() => {
      const graphCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes("/api/system/graph")
      );
      expect(graphCalls.length).toBe(0);
      const logCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes("/api/system/logs")
      );
      expect(logCalls.length).toBe(0);
    });
  });

  it("renders the knowledge graph when its tab is opened", async () => {
    render(<StatisticsView onBack={() => {}} />);
    await screen.findByText("yggdrasil-server");

    await userEvent.click(screen.getByRole("tab", { name: "Knowledge graph" }));

    // Graph stats render.
    expect(await screen.findByText("Semantic nodes")).toBeInTheDocument();
    expect(screen.getByText("Episodic nodes")).toBeInTheDocument();
    // Top hub listed.
    expect(screen.getByText("project-yggdrasil")).toBeInTheDocument();
    // SVG nodes are present.
    expect(document.querySelectorAll("svg circle").length).toBe(3);
    expect(document.querySelectorAll("svg line").length).toBe(2);
  });

  it("shows the graph loading skeleton before data lands", async () => {
    // Delay the graph response until after the tab renders.
    fetchMock.mockImplementationOnce(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/system/graph")) {
        await new Promise((r) => setTimeout(r, 50));
        return new Response(JSON.stringify(mockGraph), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return baseFetch(input);
    });

    render(<StatisticsView onBack={() => {}} />);
    await screen.findByText("yggdrasil-server");
    await userEvent.click(screen.getByRole("tab", { name: "Knowledge graph" }));

    expect(
      await screen.findByText("Semantic nodes")
    ).toBeInTheDocument();
  });

  it("renders logs with level count chips and filtering", async () => {
    render(<StatisticsView onBack={() => {}} />);
    await screen.findByText("yggdrasil-server");

    await userEvent.click(screen.getByRole("tab", { name: "System logs" }));

    // Entries render.
    expect(await screen.findByText("Stream completed")).toBeInTheDocument();
    expect(screen.getByText("Provider timeout")).toBeInTheDocument();

    // Level chips show counts from the buffer: ≥ debug 4, ≥ info 3,
    // ≥ warn 2, ≥ error 1.
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("filters logs by search text", async () => {
    render(<StatisticsView onBack={() => {}} />);
    await screen.findByText("yggdrasil-server");
    await userEvent.click(screen.getByRole("tab", { name: "System logs" }));
    expect(await screen.findByText("Stream completed")).toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText("Filter logs by text or scope"),
      "timeout"
    );

    await waitFor(() => {
      expect(screen.queryByText("Stream completed")).not.toBeInTheDocument();
      expect(screen.getByText("Provider timeout")).toBeInTheDocument();
    });
  });

  it("stops log polling when switching away from the logs tab", async () => {
    render(<StatisticsView onBack={() => {}} />);
    await screen.findByText("yggdrasil-server");
    await userEvent.click(screen.getByRole("tab", { name: "System logs" }));
    expect(await screen.findByText("Stream completed")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Overview" }));

    const logCallCount = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/api/system/logs")
    ).length;

    // Wait out one full 3s poll cycle with real timers; the unmounted
    // logs tab must not fire another request.
    await new Promise((r) => setTimeout(r, 3400));

    const afterCount = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/api/system/logs")
    ).length;
    expect(afterCount).toBe(logCallCount);
  }, 10000);

  it("clears logs via the Clear button", async () => {
    render(<StatisticsView onBack={() => {}} />);
    await screen.findByText("yggdrasil-server");
    await userEvent.click(screen.getByRole("tab", { name: "System logs" }));
    expect(await screen.findByText("Stream completed")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        (c) =>
          String(c[0]) === "/api/system/logs" &&
          (c as unknown[])[1] != null &&
          ((c as unknown[])[1] as RequestInit).method === "DELETE"
      );
      expect(del).toBeDefined();
    });

    // Entries disappear after the successful clear.
    await waitFor(() => {
      expect(screen.queryByText("Stream completed")).not.toBeInTheDocument();
    });
  });
});
