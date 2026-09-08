import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { SubagentsView } from "../subagents-view";

// vitest runs without globals:true, so RTL's auto-cleanup never registers.
afterEach(() => {
  cleanup();
});

const mockSubagents = [
  {
    id: "sub_researcher",
    name: "Researcher",
    instructions: "You are a research agent.",
    tools: ["web_search", "web_fetch", "memory"],
    enabled: true,
    maxSteps: 12,
    description: "Explores the web and memory",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    builtIn: true,
  },
  {
    id: "sub_coder",
    name: "Coder",
    instructions: "You are a coding agent.",
    tools: ["sandbox", "tasks"],
    enabled: false,
    maxSteps: 20,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    builtIn: true,
  },
];

const mockToolRegistry = [
  { key: "web_search", label: "Web Search", description: "Search the web" },
  { key: "web_fetch", label: "Fetch Page", description: "Read a URL" },
  { key: "memory", label: "Memory", description: "Recall memories" },
  { key: "sandbox", label: "Sandbox", description: "bash and files" },
];

// Base fetch implementation; individual tests override with
// fetchMock.mockImplementationOnce as needed.
const fetchMock = vi.fn(
  async (input: RequestInfo | URL, _opts?: RequestInit) => {
    void _opts;
    const url = String(input);
    if (url === "/api/subagents") {
      return new Response(
        JSON.stringify({
          subagents: mockSubagents,
          toolRegistry: mockToolRegistry,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  }
);

describe("SubagentsView", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });

  it("lists subagents with tool badges and enabled state", async () => {
    render(<SubagentsView onBack={() => {}} />);
    expect(await screen.findByText("Researcher")).toBeInTheDocument();
    expect(screen.getByText("Coder")).toBeInTheDocument();

    // Tool capability badges render.
    expect(screen.getByText("web_search")).toBeInTheDocument();
    expect(screen.getByText("sandbox")).toBeInTheDocument();

    // Enabled/disabled badges.
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();

    // Built-in badge on both.
    expect(screen.getAllByText("built-in").length).toBe(2);
  });

  it("toggles a subagent via PATCH", async () => {
    render(<SubagentsView onBack={() => {}} />);
    const toggle = await screen.findByRole("switch", {
      name: "Toggle Researcher",
    });
    fireEvent.click(toggle);

    const calls = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "PATCH"
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][1]).toMatchObject({
      body: JSON.stringify({ id: "sub_researcher", enabled: false }),
    });
  });

  it("opens the add dialog with the tool registry", async () => {
    render(<SubagentsView onBack={() => {}} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /add subagent/i })
    );

    expect(
      screen.getByText(/Each subagent runs with its own context window/)
    ).toBeInTheDocument();
    // Registry entries are rendered as toggle buttons.
    expect(screen.getByText("Web Search")).toBeInTheDocument();
    expect(screen.getByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("Sandbox")).toBeInTheDocument();

    // Validation fires on empty submit.
    fireEvent.click(screen.getByRole("button", { name: /create subagent/i }));
    expect(screen.getByText("Name is required")).toBeInTheDocument();
    expect(screen.getByText("Instructions are required")).toBeInTheDocument();
    expect(
      screen.getByText("Grant at least one tool capability")
    ).toBeInTheDocument();
  });

  it("creates a subagent via POST", async () => {
    render(<SubagentsView onBack={() => {}} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /add subagent/i })
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Writer" },
    });
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "You write things." },
    });
    // Grant one capability.
    fireEvent.click(screen.getByText("Web Search"));
    fireEvent.click(screen.getByRole("button", { name: /create subagent/i }));

    const calls = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST"
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][1]).toMatchObject({
      body: JSON.stringify({
        name: "Writer",
        instructions: "You write things.",
        tools: ["web_search"],
        enabled: true,
        model: "",
        maxSteps: 12,
        description: "",
      }),
    });
  });

  it("edits a subagent via PATCH", async () => {
    render(<SubagentsView onBack={() => {}} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit Researcher" })
    );

    const instructions = await screen.findByLabelText("Instructions");
    expect(instructions).toHaveValue("You are a research agent.");
    fireEvent.change(instructions, {
      target: { value: "You are a BETTER research agent." },
    });

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === "PATCH"
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0][1]).toMatchObject({
        body: JSON.stringify({
          id: "sub_researcher",
          name: "Researcher",
          instructions: "You are a BETTER research agent.",
          tools: ["web_search", "web_fetch", "memory"],
          enabled: true,
          model: "",
          maxSteps: 12,
          description: "Explores the web and memory",
        }),
      });
    });
  });

  it("deletes a subagent after confirmation", async () => {
    render(<SubagentsView onBack={() => {}} />);
    await screen.findByText("Researcher");

    fireEvent.click(screen.getByRole("button", { name: "Delete Coder" }));
    // Confirm dialog describes what is being removed (curly quotes in UI).
    expect(screen.getByText(/Remove “Coder”/)).toBeInTheDocument();

    const confirmButtons = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/subagents?id=sub_coder",
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });

  it("shows server validation errors inline from the API", async () => {
    render(<SubagentsView onBack={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /add subagent/i }));

    // Fill a valid form so client-side validation passes.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Writer" },
    });
    fireEvent.change(screen.getByLabelText("Instructions"), {
      target: { value: "You write." },
    });
    fireEvent.click(screen.getByText("Web Search"));

    // Override the next fetch: POST fails with issues.
    fetchMock.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({
          error: 'A subagent named "Writer" already exists',
          issues: ['A subagent named "Writer" already exists'],
        }),
        { status: 400 }
      )
    );

    fireEvent.click(screen.getByRole("button", { name: /create subagent/i }));

    await waitFor(() => {
      expect(
        screen.getByText('A subagent named "Writer" already exists')
      ).toBeInTheDocument();
    });
  });
});
