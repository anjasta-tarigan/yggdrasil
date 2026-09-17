import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ImportProjectDialog } from "../ImportProjectDialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ImportProjectDialog", () => {
  it("renders form fields and restricted access explanation notice", () => {
    render(<ImportProjectDialog open={true} onOpenChange={() => {}} />);

    expect(screen.getByRole("heading", { name: /import existing project/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/project name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/directory path/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/custom instructions/i)).toBeInTheDocument();

    // Verify restricted access notice is displayed
    expect(screen.getByText(/restricted access notice/i)).toBeInTheDocument();
    expect(screen.getByText(/restricted mode/i)).toBeInTheDocument();
  });

  it("submits POST /api/projects with mode: existing on valid input", async () => {
    const handleProjectCreated = vi.fn();
    const handleOpenChange = vi.fn();
    const mockCreated = {
      id: "p-imported",
      name: "legacy-app",
      directoryPath: "/home/user/code/legacy-app",
      description: "Existing codebase",
      customInstructions: "No mutations without approval",
      trusted: false,
      existsOnDisk: true,
    };

    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockCreated,
    } as unknown as Response);

    render(
      <ImportProjectDialog
        open={true}
        onOpenChange={handleOpenChange}
        onProjectCreated={handleProjectCreated}
      />
    );

    fireEvent.change(screen.getByLabelText(/project name/i), {
      target: { value: "legacy-app" },
    });
    fireEvent.change(screen.getByLabelText(/directory path/i), {
      target: { value: "/home/user/code/legacy-app" },
    });
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: "Existing codebase" },
    });
    fireEvent.change(screen.getByLabelText(/custom instructions/i), {
      target: { value: "No mutations without approval" },
    });

    const submitBtn = screen.getByRole("button", { name: /import project/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "legacy-app",
            directoryPath: "/home/user/code/legacy-app",
            description: "Existing codebase",
            customInstructions: "No mutations without approval",
            mode: "existing",
          }),
        })
      );
      expect(handleProjectCreated).toHaveBeenCalledWith(mockCreated);
      expect(handleOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("displays server error message on failure", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Directory does not exist" }),
    } as unknown as Response);

    render(<ImportProjectDialog open={true} onOpenChange={() => {}} />);

    fireEvent.change(screen.getByLabelText(/project name/i), {
      target: { value: "missing-app" },
    });
    fireEvent.change(screen.getByLabelText(/directory path/i), {
      target: { value: "/path/that/does/not/exist" },
    });

    const submitBtn = screen.getByRole("button", { name: /import project/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/directory does not exist/i)).toBeInTheDocument();
    });
  });
});
