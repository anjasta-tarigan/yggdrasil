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

const mockChatMessages = [
  {
    id: "msg-1",
    role: "user",
    parts: [{ type: "text", text: "Run project tests and generate report" }],
  },
  {
    id: "msg-2",
    role: "assistant",
    parts: [
      {
        type: "reasoning",
        text: "Analyzing project test structure and running vitest suite with coverage.",
      },
      {
        type: "dynamic-tool",
        toolName: "manage_tasks",
        toolCallId: "call-task-1",
        state: "output-available",
        input: {
          title: "Test Plan",
          items: [
            { text: "Run test suite", status: "completed" },
            { text: "Verify regression", status: "in_progress" },
          ],
        },
        output: {
          title: "Test Plan",
          items: [
            { text: "Run test suite", status: "completed" },
            { text: "Verify regression", status: "in_progress" },
          ],
        },
      },
      {
        type: "dynamic-tool",
        toolName: "projectBash",
        toolCallId: "call-bash-1",
        state: "output-available",
        input: { command: "pnpm test" },
        output: { stdout: "✓ 5 tests passed", stderr: "", exitCode: 0 },
      },
      {
        type: "dynamic-tool",
        toolName: "create_artifact",
        toolCallId: "call-art-1",
        state: "output-available",
        input: {
          title: "Test Summary Report",
          kind: "document",
          content: "# Test Summary\nAll 5 unit tests passed with 100% coverage.",
        },
        output: {
          title: "Test Summary Report",
          kind: "document",
          content: "# Test Summary\nAll 5 unit tests passed with 100% coverage.",
        },
      },
      { type: "text", text: "All tests executed and passed successfully!" },
    ],
  },
];

vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn(() => ({
    messages: mockChatMessages,
    sendMessage: vi.fn(),
    status: "ready",
    stop: vi.fn(),
  })),
}));

describe("ProjectsView Component", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (typeof url === "string" && url === "/api/projects") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ projects: mockProjects }),
        } as Response);
      }
      if (typeof url === "string" && url.includes("/sessions")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sessions: [] }),
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

  it("renders reasoning block and terminal tool outputs in harness chat", async () => {
    const handleBack = vi.fn();
    render(<ProjectsView onBack={handleBack} />);

    await waitFor(() => {
      expect(screen.getAllByText("Web Platform App").length).toBeGreaterThan(0);
    });

    // Reasoning rendering
    expect(
      screen.getAllByText(/Analyzing project test structure/i).length
    ).toBeGreaterThan(0);

    // Terminal viewer for projectBash
    expect(screen.getAllByText("pnpm test").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/✓ 5 tests passed/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("exit 0").length).toBeGreaterThan(0);

    // Task plan checklist
    expect(screen.getAllByText(/Test Plan/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Run test suite").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Verify regression").length).toBeGreaterThan(0);

    // Artifact Chip
    expect(screen.getAllByText("Test Summary Report").length).toBeGreaterThan(0);

    // Final response
    expect(
      screen.getAllByText(/All tests executed and passed successfully!/i).length
    ).toBeGreaterThan(0);
  });
});
