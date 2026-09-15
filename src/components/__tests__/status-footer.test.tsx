import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { StatusFooter } from "@/components/status-footer";
import type { SystemHealth } from "@/hooks/use-system-health";

afterEach(() => {
  cleanup();
});

function health(
  overrides: Partial<SystemHealth> = {}
): SystemHealth {
  return {
    status: "ok",
    latencyMs: 12,
    uptimeSeconds: 3600,
    memoryHeapMb: 64,
    version: "1.0.0",
    modelId: "meta-llama/llama-3.1-8b",
    modelCount: 24,
    subsystems: {
      database: { status: "ok", latencyMs: 1, wal: true },
      queue: { status: "ok", running: true, pendingJobs: 0, failedJobs: 0 },
      daemon: { status: "ok", running: true, armedSchedules: 3 },
    },
    ...overrides,
  };
}

describe("StatusFooter", () => {
  it("renders the system health status, latency, and active model", () => {
    render(
      <StatusFooter
        health={health()}
        model="meta-llama/llama-3.1-8b"
      />
    );

    expect(screen.getByText("Operational")).toBeInTheDocument();
    expect(screen.getByText(/System/)).toBeInTheDocument();
    expect(screen.getByText("12ms")).toBeInTheDocument();
    expect(screen.getByText("meta-llama/llama-3.1-8b")).toBeInTheDocument();
    expect(screen.getByText("24 models")).toBeInTheDocument();
  });

  it("opens internal system health details popover on click", () => {
    render(
      <StatusFooter
        health={health()}
        model="meta-llama/llama-3.1-8b"
      />
    );

    const trigger = screen.getByRole("button", { name: /inspect yggdrasil system health/i });
    fireEvent.click(trigger);

    expect(screen.getByText("Yggdrasil Core System")).toBeInTheDocument();
    expect(screen.getByText("Database (SQLite)")).toBeInTheDocument();
    expect(screen.getByText("Queue Runner")).toBeInTheDocument();
    expect(screen.getByText("Cognitive Daemon")).toBeInTheDocument();
    expect(screen.getByText(/Uptime: 1h/)).toBeInTheDocument();
    expect(screen.getByText("Heap: 64MB")).toBeInTheDocument();
  });

  it("falls back to the server modelId when no model is passed", () => {
    render(<StatusFooter health={health()} model={null} />);
    expect(screen.getByText("meta-llama/llama-3.1-8b")).toBeInTheDocument();
  });

  it.each([
    ["ok", "Operational"],
    ["degraded", "Degraded"],
    ["down", "Offline"],
    ["checking", "Checking…"],
  ] as const)("renders the right system label for status %s", (status, label) => {
    render(<StatusFooter health={health({ status })} model={null} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("hides latency while checking", () => {
    render(
      <StatusFooter
        health={health({ status: "checking", latencyMs: undefined })}
        model={null}
      />
    );
    expect(screen.queryByText(/ms$/)).not.toBeInTheDocument();
  });

  it("renders embedding and reranker lifecycle states", () => {
    render(
      <StatusFooter
        health={
          health({
            services: {
              embedding: {
                status: "running",
                provider: "onnx",
                model: "bge-small-en-v1.5",
                loaded: true,
              },
              reranker: {
                status: "standby",
                provider: "onnx",
                model: "bge-reranker-v2-m3",
                loaded: false,
              },
            },
          })
        }
        model={null}
      />
    );

    expect(screen.getByText("Embedding")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("bge-small-en-v1.5")).toBeInTheDocument();

    expect(screen.getByText("Reranker")).toBeInTheDocument();
    expect(screen.getByText("Standby")).toBeInTheDocument();
    expect(screen.getByText("bge-reranker-v2-m3")).toBeInTheDocument();
  });

  it("renders 'Unloaded' when both services are unloaded", () => {
    render(
      <StatusFooter
        health={
          health({
            services: {
              embedding: {
                status: "unload",
                provider: "unconfigured",
                model: null,
                loaded: false,
              },
              reranker: {
                status: "unload",
                provider: "disabled",
                model: null,
                loaded: false,
              },
            },
          })
        }
        model={null}
      />
    );

    expect(screen.getAllByText("Unloaded")).toHaveLength(2);
    // No model filenames leak through when unloaded.
    expect(screen.queryByText(/onnx$/)).not.toBeInTheDocument();
  });

  it("shows a neutral state for services before the first poll resolves", () => {
    render(<StatusFooter health={{ status: "checking" }} model={null} />);
    // System is checking; services are unknown initially.
    expect(screen.getByText("Checking…")).toBeInTheDocument();
  });
});
