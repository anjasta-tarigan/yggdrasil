import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ProjectsList } from "../ProjectsList";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProjectsList", () => {
  const mockPaginatedResponse = {
    projects: [
      {
        id: "proj_1",
        name: "My Web App",
        description: "A cool web application",
        directoryPath: "/home/user/web-app",
        isCustomDirectory: false,
        trusted: true,
        trustedAt: Date.now(),
        customInstructions: null,
        existsOnDisk: true,
        createdAt: Date.now() - 3600_000,
        updatedAt: Date.now() - 3600_000,
      },
      {
        id: "proj_2",
        name: "External Tool",
        description: null,
        directoryPath: "/home/user/tool",
        isCustomDirectory: true,
        trusted: false,
        trustedAt: null,
        customInstructions: null,
        existsOnDisk: false,
        createdAt: Date.now() - 7200_000,
        updatedAt: Date.now() - 7200_000,
      },
    ],
    total: 2,
    totalPages: 1,
    hasMore: false,
    hasPrev: false,
  };

  it("renders projects list and displays trust badges", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockPaginatedResponse,
    } as unknown as Response);

    render(<ProjectsList onSelectProject={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("My Web App")).toBeInTheDocument();
      expect(screen.getByText("External Tool")).toBeInTheDocument();
      expect(screen.getByText("Trusted")).toBeInTheDocument();
      expect(screen.getByText(/restricted/i)).toBeInTheDocument();
    });
  });

  it("displays existsOnDisk status badge for available and missing projects", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockPaginatedResponse,
    } as unknown as Response);

    render(<ProjectsList onSelectProject={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/available on disk/i)).toBeInTheDocument();
      expect(screen.getByText(/missing from disk/i)).toBeInTheDocument();
    });
  });

  it("calls onSelectProject when a project is clicked", async () => {
    const handleSelect = vi.fn();
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockPaginatedResponse,
    } as unknown as Response);

    render(<ProjectsList onSelectProject={handleSelect} />);

    await waitFor(() => {
      expect(screen.getByText("My Web App")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("My Web App"));
    expect(handleSelect).toHaveBeenCalledWith(mockPaginatedResponse.projects[0]);
  });

  it("opens New Project dialog when + New Project is clicked", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockPaginatedResponse,
    } as unknown as Response);

    render(<ProjectsList onSelectProject={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("My Web App")).toBeInTheDocument();
    });

    const newBtn = screen.getByRole("button", { name: /new project/i });
    fireEvent.click(newBtn);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/create project/i, { selector: "h2, [data-slot='dialog-title'], [role='heading']" })).toBeInTheDocument();
  });

  it("opens Import Existing dialog when Import Existing is clicked", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockPaginatedResponse,
    } as unknown as Response);

    render(<ProjectsList onSelectProject={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("My Web App")).toBeInTheDocument();
    });

    const importBtn = screen.getByRole("button", { name: /import existing/i });
    fireEvent.click(importBtn);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/import existing project/i, { selector: "h2, [data-slot='dialog-title'], [role='heading']" })).toBeInTheDocument();
  });

  it("allows deleting a project with confirmation", async () => {
    const fetchMock = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockPaginatedResponse,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      } as unknown as Response);

    render(<ProjectsList onSelectProject={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("My Web App")).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByRole("button", { name: /delete project/i });
    fireEvent.click(deleteButtons[0]);

    // Confirmation dialog appears
    const confirmBtn = screen.getByRole("button", { name: /^delete$/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/proj_1",
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });

  it("renders pagination controls when totalPages > 1", async () => {
    const paginated = {
      ...mockPaginatedResponse,
      total: 5,
      totalPages: 3,
      hasMore: true,
      hasPrev: false,
    };

    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => paginated,
    } as unknown as Response);

    render(<ProjectsList onSelectProject={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/5 projects/)).toBeInTheDocument();
    });

    expect(screen.getAllByRole("button", { name: /page/i })).toHaveLength(4);
    expect(screen.getByRole("button", { name: /previous page/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next page/i })).not.toBeDisabled();
  });

  it("navigates to next page when Next is clicked", async () => {
    const page1 = {
      ...mockPaginatedResponse,
      total: 5,
      totalPages: 3,
      hasMore: true,
      hasPrev: false,
    };
    const page2 = {
      ...mockPaginatedResponse,
      total: 5,
      totalPages: 3,
      hasMore: true,
      hasPrev: true,
    };

    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => page1,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => page2,
      } as unknown as Response);

    render(<ProjectsList onSelectProject={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("My Web App")).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const nextBtn = screen.getByRole("button", { name: /next page/i });
    fireEvent.click(nextBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/projects?page=2&limit=20"),
        expect.any(Object)
      );
    });
  });

  it("shows selection checkboxes when Select All is clicked", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockPaginatedResponse,
    } as unknown as Response);

    render(<ProjectsList onSelectProject={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("My Web App")).toBeInTheDocument();
    });

    // Initially no checkboxes
    expect(screen.queryByRole("button", { name: /select project/i })).toBeNull();

    // Click "Select All"
    const selectAllBtn = screen.getByRole("button", { name: /select all/i });
    fireEvent.click(selectAllBtn);

    // Now checkboxes should appear on project cards
    expect(screen.getAllByRole("button", { name: /deselect project/i })).toHaveLength(2);

    // "Delete 2" button should appear
    expect(screen.getByRole("button", { name: /delete 2/i })).toBeInTheDocument();
  });

  it("allows individual project selection and toggling", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockPaginatedResponse,
    } as unknown as Response);

    render(<ProjectsList onSelectProject={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("My Web App")).toBeInTheDocument();
    });

    // Click "Select All"
    const selectAllBtn = screen.getByRole("button", { name: /select all/i });
    fireEvent.click(selectAllBtn);

    // Deselect first project
    const deselectBtns = screen.getAllByRole("button", { name: /deselect project/i });
    fireEvent.click(deselectBtns[0]);

    // Should now show "Delete 1"
    expect(screen.getByRole("button", { name: /delete 1/i })).toBeInTheDocument();

    // Re-select first project
    const selectBtns = screen.getAllByRole("button", { name: /select project/i });
    fireEvent.click(selectBtns[0]);

    // Should show "Delete 2" again
    expect(screen.getByRole("button", { name: /delete 2/i })).toBeInTheDocument();
  });

  it("shows bulk delete confirmation dialog and executes on confirm", async () => {
    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockPaginatedResponse,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          deleted: 2,
          projects: [],
          total: 0,
          totalPages: 1,
          hasMore: false,
          hasPrev: false,
        }),
      } as unknown as Response);

    render(<ProjectsList onSelectProject={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("My Web App")).toBeInTheDocument();
    });

    // Select all projects
    const selectAllBtn = screen.getByRole("button", { name: /select all/i });
    fireEvent.click(selectAllBtn);

    // Click bulk delete
    const deleteBtn = screen.getByRole("button", { name: /delete 2/i });
    fireEvent.click(deleteBtn);

    // Confirmation dialog should appear
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/are you sure you want to delete 2 projects/i)
    ).toBeInTheDocument();

    // Confirm
    const confirmBtn = screen.getByRole("button", { name: /^delete 2$/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects",
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });

  it("hides selection UI when Clear Selection is clicked", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockPaginatedResponse,
    } as unknown as Response);

    render(<ProjectsList onSelectProject={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("My Web App")).toBeInTheDocument();
    });

    // Enter selection mode
    fireEvent.click(screen.getByRole("button", { name: /select all/i }));
    expect(screen.getAllByRole("button", { name: /deselect project/i })).toHaveLength(2);

    // Exit selection mode
    fireEvent.click(screen.getByRole("button", { name: /clear selection/i }));
    expect(screen.queryByRole("button", { name: /deselect project/i })).toBeNull();
    expect(screen.getByRole("button", { name: /select all/i })).toBeInTheDocument();
  });
});
