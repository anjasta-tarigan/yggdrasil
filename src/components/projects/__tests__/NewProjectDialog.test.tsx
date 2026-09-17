import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { NewProjectDialog } from "../NewProjectDialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NewProjectDialog", () => {
  it("renders form fields and sanitized preview", () => {
    render(<NewProjectDialog open={true} onOpenChange={() => {}} />);

    expect(screen.getByRole("heading", { name: /create project/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/project name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/custom instructions/i)).toBeInTheDocument();

    const nameInput = screen.getByLabelText(/project name/i);
    fireEvent.change(nameInput, { target: { value: "My New App!" } });

    // Location preview should show sanitized name
    expect(screen.getByText(/data\/projects\/my-new-app/i)).toBeInTheDocument();
  });

  it("submits POST /api/projects with mode: new on valid input", async () => {
    const handleProjectCreated = vi.fn();
    const handleOpenChange = vi.fn();
    const mockCreated = {
      id: "p-new",
      name: "awesome-project",
      description: "My project description",
      customInstructions: "Follow strict rules",
      directoryPath: "/app/data/projects/awesome-project",
      trusted: true,
      existsOnDisk: true,
    };

    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => mockCreated,
    } as unknown as Response);

    render(
      <NewProjectDialog
        open={true}
        onOpenChange={handleOpenChange}
        onProjectCreated={handleProjectCreated}
      />
    );

    fireEvent.change(screen.getByLabelText(/project name/i), {
      target: { value: "awesome-project" },
    });
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: "My project description" },
    });
    fireEvent.change(screen.getByLabelText(/custom instructions/i), {
      target: { value: "Follow strict rules" },
    });

    const submitBtn = screen.getByRole("button", { name: /create project/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "awesome-project",
            description: "My project description",
            customInstructions: "Follow strict rules",
            mode: "new",
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
      json: async () => ({ error: "A project with this name already exists" }),
    } as unknown as Response);

    render(<NewProjectDialog open={true} onOpenChange={() => {}} />);

    fireEvent.change(screen.getByLabelText(/project name/i), {
      target: { value: "duplicate-proj" },
    });

    const submitBtn = screen.getByRole("button", { name: /create project/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/already exists/i)).toBeInTheDocument();
    });
  });
});
