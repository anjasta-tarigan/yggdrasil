import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { CronJobsView } from "../cron-jobs-view";

const mockResponse = {
  daemonRunning: true,
  queueRunnerRunning: true,
  schedules: {
    light_sleep: "*/15 * * * *",
    dream_cycle: "0 * * * *",
    decay_sweep: "0 3 * * *",
  },
  definitions: [
    {
      name: "Light Sleep Consolidation",
      schedule: "*/15 * * * *",
      description: "Consolidates and summarizes recent episodic memories into semantic knowledge",
      passName: "light_sleep",
      jobType: "sleep_consolidation",
    },
  ],
  recentJobs: [
    {
      id: "job_test_1",
      type: "sleep_consolidation",
      payload: {},
      status: "completed",
      attempts: 1,
      maxAttempts: 3,
      lastError: null,
      lockedAt: null,
      runAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
};

describe("CronJobsView Component", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url, opts) => {
      if (typeof url === "string" && url === "/api/cron" && opts?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, jobId: "job_new_123" }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      } as Response);
    });
  });

  it("renders cron jobs definitions and executions", async () => {
    const handleBack = vi.fn();
    render(<CronJobsView onBack={handleBack} />);

    expect(screen.getByText("Cron Jobs & Scheduled Tasks")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Light Sleep Consolidation")).toBeInTheDocument();
    });

    expect(screen.getByText("job_test_1")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();

    // Trigger run now button
    const runButton = screen.getByRole("button", { name: /run now/i });
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(screen.getByText(/Successfully enqueued job job_new_123/i)).toBeInTheDocument();
    });
  });
});
