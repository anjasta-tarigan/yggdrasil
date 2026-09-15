import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { CronJobsView } from "../cron-jobs-view";

// vitest runs without globals:true, so RTL's auto-cleanup (which checks the
// global afterEach) never registers. Clean up explicitly between tests.
afterEach(() => {
  cleanup();
});

const mockResponse = {
  daemonRunning: true,
  queueRunnerRunning: true,
  schedules: [
    {
      id: "cron_sleep_consolidation",
      name: "Light Sleep Consolidation",
      schedule: "*/15 * * * *",
      description:
        "Consolidates and summarizes recent episodic memories into semantic knowledge",
      jobType: "sleep_consolidation",
      enabled: true,
      nextRunAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      builtIn: true,
    },
    {
      id: "cron_decay_sweep",
      name: "Deep Sleep Decay Sweep",
      schedule: "0 3 * * *",
      description: "Decay sweep",
      jobType: "decay_sweep",
      enabled: false,
      nextRunAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      builtIn: true,
    },
  ],
  schedulableJobTypes: [
    {
      jobType: "sleep_consolidation",
      label: "Light Sleep Consolidation",
      description: "Summarizes recent episodic memories (LLM)",
    },
    {
      jobType: "dream_graph_discovery",
      label: "Dream Cycle Discovery",
      description: "Graph edge discovery (SQL)",
    },
    {
      jobType: "decay_sweep",
      label: "Deep Sleep Decay Sweep",
      description: "Forgetting-curve decay (SQL)",
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
  jobsPagination: {
    page: 1,
    pageSize: 20,
    total: 43,
    totalPages: 3,
  },
};

const fetchMock = vi.fn((url: unknown, opts?: RequestInit) => {
  const urlStr = typeof url === "string" ? url : String(url);
  if (urlStr === "/api/cron" && opts?.method === "POST") {
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

beforeEach(() => {
  fetchMock.mockClear();
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
});

describe("CronJobsView Component", () => {
  it("renders configured schedules and executions", async () => {
    const handleBack = vi.fn();
    render(<CronJobsView onBack={handleBack} />);

    expect(screen.getByText("Cron Jobs & Scheduled Tasks")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Light Sleep Consolidation")).toBeInTheDocument();
    });

    expect(screen.getByText("Deep Sleep Decay Sweep")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText("job_test_1")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("runs a schedule now and shows feedback", async () => {
    render(<CronJobsView onBack={() => {}} />);

    const runButtons = await screen.findAllByRole("button", {
      name: /run now/i,
    });
    expect(runButtons.length).toBe(2); // two enabled schedules in the mock
    fireEvent.click(runButtons[0]);

    await waitFor(() => {
      expect(screen.getByText(/job_new_123/i)).toBeInTheDocument();
    });
  });

  it("opens the add-schedule dialog and validates input", async () => {
    render(<CronJobsView onBack={() => {}} />);

    const addBtn = await screen.findByRole("button", {
      name: /add schedule/i,
    });
    fireEvent.click(addBtn);

    // Dialog opened: its description text only exists inside the dialog
    expect(
      await screen.findByText(/Changes apply live/i)
    ).toBeInTheDocument();

    // Save with empty form → validation errors appear
    const createBtn = screen.getByRole("button", {
      name: /create schedule/i,
    });
    fireEvent.click(createBtn);

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(
      screen.getByText("Cron expression is required")
    ).toBeInTheDocument();
    expect(screen.getByText("Select a job type")).toBeInTheDocument();
  });

  it("rejects malformed cron expressions client-side", async () => {
    render(<CronJobsView onBack={() => {}} />);

    fireEvent.click(
      await screen.findByRole("button", { name: /add schedule/i })
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Nightly tidy" },
    });
    fireEvent.change(screen.getByPlaceholderText("*/15 * * * *"), {
      target: { value: "not a cron" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create schedule/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/must have 5 fields/i)
      ).toBeInTheDocument();
    });
  });

  it("opens edit dialog prefilled from the schedule entry", async () => {
    render(<CronJobsView onBack={() => {}} />);

    const editBtn = await screen.findByRole("button", {
      name: /edit light sleep consolidation/i,
    });
    fireEvent.click(editBtn);

    expect(await screen.findByText("Edit Schedule")).toBeInTheDocument();
    const nameInput = await screen.findByLabelText("Name");
    expect((nameInput as HTMLInputElement).value).toBe(
      "Light Sleep Consolidation"
    );
    const exprInput = await screen.findByPlaceholderText("*/15 * * * *");
    expect((exprInput as HTMLInputElement).value).toBe("*/15 * * * *");
  });

  it("confirms before deleting a schedule", async () => {
    render(<CronJobsView onBack={() => {}} />);

    const deleteBtn = await screen.findByRole("button", {
      name: /delete deep sleep decay sweep/i,
    });
    fireEvent.click(deleteBtn);

    expect(await screen.findByText("Delete schedule")).toBeInTheDocument();
    // Confirm button visible inside dialog
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument();
  });

  it("paginates executions server-side with a pager", async () => {
    render(<CronJobsView onBack={() => {}} />);

    // Header shows the total from jobsPagination, not the page slice
    expect(await screen.findByText("Recent Executions (43)")).toBeInTheDocument();

    // 3 total pages → pager visible with next enabled
    const nextBtn = await screen.findByRole("button", {
      name: /next page of executions/i,
    });
    expect(nextBtn).not.toBeDisabled();

    const prevBtn = screen.getByRole("button", {
      name: /previous page of executions/i,
    });
    expect(prevBtn).toBeDisabled();

    // Page indicator shows current position (scoped to the executions pager
    // — the attempts column also renders "1 / 3" patterns)
    const executionsPager = screen.getByTestId("pager-executions");
    expect(
      within(executionsPager).getByText("1 / 3")
    ).toBeInTheDocument();

    // Showing range text
    expect(screen.getByText(/Showing 1-1 of 43 executions/i)).toBeInTheDocument();

    // Next page request fetches page 2 from the server
    fireEvent.click(nextBtn);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/cron?page=2"),
        expect.objectContaining({ cache: "no-store" })
      )
    );
  });

  it("paginates schedules client-side after exceeding page size", async () => {
    // 6 schedules > 5 per page
    const manySchedules = Array.from({ length: 6 }, (_, i) => ({
      ...mockResponse.schedules[0],
      id: `cron_extra_${i}`,
      name: `Schedule ${i + 1}`,
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation((url, opts) => {
      const urlStr = typeof url === "string" ? url : String(url);
      if (urlStr === "/api/cron" && opts?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, jobId: "job_new_123" }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ ...mockResponse, schedules: manySchedules }),
      } as Response);
    });

    render(<CronJobsView onBack={() => {}} />);

    // Page 1 shows the first 5 only
    expect(await screen.findByText("Schedule 1")).toBeInTheDocument();
    expect(screen.getByText("Schedule 5")).toBeInTheDocument();
    expect(screen.queryByText("Schedule 6")).not.toBeInTheDocument();

    // Pager exists: 2 pages, next enabled
    const nextBtn = screen.getByRole("button", {
      name: /next page of schedules/i,
    });
    expect(nextBtn).not.toBeDisabled();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    // Go to page 2 → shows the 6th schedule
    fireEvent.click(nextBtn);
    expect(await screen.findByText("Schedule 6")).toBeInTheDocument();
    expect(screen.queryByText("Schedule 1")).not.toBeInTheDocument();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });
});
