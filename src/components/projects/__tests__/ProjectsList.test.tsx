import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ProjectsList } from "../ProjectsList";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProjectsList", () => {
  const mockProjects = [
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
  ];

  it("renders projects list and displays trust badges", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockProjects,
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
      json: async () => mockProjects,
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
      json: async () => mockProjects,
    } as unknown as Response);

    render(<ProjectsList onSelectProject={handleSelect} />);

    await waitFor(() => {
      expect(screen.getByText("My Web App")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("My Web App"));
    expect(handleSelect).toHaveBeenCalledWith(mockProjects[0]);
  });

  it("opens New Project dialog when + New Project is clicked", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockProjects,
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
      json: async () => mockProjects,
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
        json: async () => mockProjects,
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
});
