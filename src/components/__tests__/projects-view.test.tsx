import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ProjectsView } from "../projects-view";

const mockProjects = [
  {
    id: "proj_1",
    name: "Web Platform App",
    description: "Full stack web application",
    directoryPath: "/tmp/mock-project-path",
    trusted: true,
    trustedAt: Date.now(),
    customInstructions: "Use strict TypeScript",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

describe("ProjectsView Component", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (typeof url === "string" && url === "/api/projects") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ projects: mockProjects }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      } as Response);
    });
  });

  it("renders projects list and active project orchestrator", async () => {
    const handleBack = vi.fn();
    render(<ProjectsView onBack={handleBack} />);

    await waitFor(() => {
      expect(screen.getAllByText("Web Platform App").length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText("/tmp/mock-project-path").length).toBeGreaterThan(0);
    expect(screen.getByText("Trusted Directory")).toBeInTheDocument();
  });
});
