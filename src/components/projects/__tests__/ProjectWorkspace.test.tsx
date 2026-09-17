import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProjectWorkspace } from "../ProjectWorkspace";
import type { StoredProject } from "@/lib/project-service";

const mockSendMessage = vi.fn();
const mockSetMessages = vi.fn();
const mockAddToolApprovalResponse = vi.fn();
const mockStop = vi.fn();

vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn(() => ({
    messages: [],
    sendMessage: mockSendMessage,
    setMessages: mockSetMessages,
    status: "ready",
    stop: mockStop,
    error: null,
    regenerate: vi.fn(),
    addToolResult: vi.fn(),
    addToolApprovalResponse: mockAddToolApprovalResponse,
  })),
}));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function createMockResponse(data: unknown, ok = true): Response {
  return {
    ok,
    json: async () => data,
  } as unknown as Response;
}

describe("ProjectWorkspace", () => {
  const untrustedProject: StoredProject = {
    id: "proj_untrusted",
    name: "Untrusted Project",
    description: "An untrusted project description",
    directoryPath: "/tmp/untrusted",
    trusted: false,
    trustedAt: null,
    isCustomDirectory: true,
    customInstructions: null,
    existsOnDisk: true,
    createdAt: 1000,
    updatedAt: 1000,
  };

  const trustedProject: StoredProject = {
    id: "proj_trusted",
    name: "Trusted Project",
    description: "A trusted project description",
    directoryPath: "/tmp/trusted",
    trusted: true,
    trustedAt: 2000,
    isCustomDirectory: false,
    customInstructions: null,
    existsOnDisk: true,
    createdAt: 2000,
    updatedAt: 2000,
  };

  const mockSessions = [
    {
      id: "sess_1",
      projectId: "proj_untrusted",
      title: "Initial Session",
      pinned: false,
      activeStreamId: null,
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    },
    {
      id: "sess_2",
      projectId: "proj_untrusted",
      title: "Second Session",
      pinned: false,
      activeStreamId: null,
      createdAt: 2000,
      updatedAt: 2000,
      messages: [],
    },
  ];

  const mockFiles = [
    {
      path: "src",
      isDirectory: true,
      size: 0,
    },
    {
      path: "src/index.ts",
      isDirectory: false,
      size: 1024,
    },
    {
      path: "package.json",
      isDirectory: false,
      size: 256,
    },
  ];

  it("renders ambient trust banner when project is untrusted", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes("/sessions")) {
        return createMockResponse([]);
      }
      if (String(url).includes("/files")) {
        return createMockResponse([]);
      }
      return createMockResponse({});
    });

    render(
      <ProjectWorkspace
        project={untrustedProject}
        onBack={() => {}}
        onProjectUpdated={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/directory trust required/i)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /approve trust/i })
      ).toBeInTheDocument();
    });
  });

  it("does not render ambient trust banner when project is trusted", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes("/sessions")) {
        return createMockResponse([]);
      }
      if (String(url).includes("/files")) {
        return createMockResponse([]);
      }
      return createMockResponse({});
    });

    render(
      <ProjectWorkspace
        project={trustedProject}
        onBack={() => {}}
        onProjectUpdated={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.queryByText(/directory trust required/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /approve trust/i })).not.toBeInTheDocument();
    });
  });

  it("approves trust when 'Approve Trust' button is clicked", async () => {
    const onProjectUpdated = vi.fn();
    const updatedProject = { ...untrustedProject, trusted: true, trustedAt: Date.now() };

    vi.spyOn(global, "fetch").mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes("/trust") && init?.method === "POST") {
          return createMockResponse(updatedProject);
        }
        if (String(url).includes("/sessions")) {
          return createMockResponse([]);
        }
        if (String(url).includes("/files")) {
          return createMockResponse([]);
        }
        return createMockResponse({});
      }
    );

    render(
      <ProjectWorkspace
        project={untrustedProject}
        onBack={() => {}}
        onProjectUpdated={onProjectUpdated}
      />
    );

    const approveButton = await screen.findByRole("button", { name: /approve trust/i });
    fireEvent.click(approveButton);

    await waitFor(() => {
      expect(onProjectUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ trusted: true })
      );
    });
  });

  it("loads and displays sessions list in left rail", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes("/sessions")) {
        return createMockResponse(mockSessions);
      }
      if (String(url).includes("/files")) {
        return createMockResponse([]);
      }
      return createMockResponse({});
    });

    render(
      <ProjectWorkspace
        project={untrustedProject}
        onBack={() => {}}
        onProjectUpdated={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByText("Initial Session").length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText("Second Session")).toBeInTheDocument();
    });
  });

  it("creates a new session when '+ New Session' button is clicked", async () => {
    const createdSession = {
      id: "sess_new",
      projectId: "proj_untrusted",
      title: "New Session",
      pinned: false,
      activeStreamId: null,
      createdAt: 3000,
      updatedAt: 3000,
      messages: [],
    };

    vi.spyOn(global, "fetch").mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).endsWith("/sessions") && init?.method === "POST") {
          return createMockResponse(createdSession);
        }
        if (String(url).endsWith("/sessions")) {
          return createMockResponse(mockSessions);
        }
        if (String(url).includes("/files")) {
          return createMockResponse([]);
        }
        return createMockResponse({});
      }
    );

    render(
      <ProjectWorkspace
        project={untrustedProject}
        onBack={() => {}}
        onProjectUpdated={() => {}}
      />
    );

    const newSessionButton = await screen.findByRole("button", { name: /new session/i });
    fireEvent.click(newSessionButton);

    await waitFor(() => {
      expect(screen.getByText("New Session")).toBeInTheDocument();
    });
  });

  it("allows deleting a session from the list", async () => {
    vi.spyOn(global, "fetch").mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes("/sessions/sess_1") && init?.method === "DELETE") {
          return createMockResponse({ success: true });
        }
        if (String(url).endsWith("/sessions")) {
          return createMockResponse(mockSessions);
        }
        if (String(url).includes("/files")) {
          return createMockResponse([]);
        }
        return createMockResponse({});
      }
    );

    render(
      <ProjectWorkspace
        project={untrustedProject}
        onBack={() => {}}
        onProjectUpdated={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByText("Initial Session").length).toBeGreaterThanOrEqual(1);
    });

    const deleteButtons = screen.getAllByRole("button", { name: /delete session/i });
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText("Initial Session")).not.toBeInTheDocument();
      expect(screen.getAllByText("Second Session").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("fetches and displays file tree in right drawer", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes("/sessions")) {
        return createMockResponse([]);
      }
      if (String(url).includes("/files")) {
        return createMockResponse(mockFiles);
      }
      return createMockResponse({});
    });

    render(
      <ProjectWorkspace
        project={untrustedProject}
        onBack={() => {}}
        onProjectUpdated={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
      expect(screen.getByText("index.ts")).toBeInTheDocument();
      expect(screen.getByText("package.json")).toBeInTheDocument();
    });
  });

  it("switches active session when another session is clicked", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/sessions")) {
        return createMockResponse(mockSessions);
      }
      if (String(url).includes("/sessions/sess_2")) {
        return createMockResponse(mockSessions[1]);
      }
      if (String(url).includes("/files")) {
        return createMockResponse([]);
      }
      return createMockResponse({});
    });

    render(
      <ProjectWorkspace
        project={untrustedProject}
        onBack={() => {}}
        onProjectUpdated={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Second Session")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Second Session"));

    await waitFor(() => {
      // Top bar header updates to active session title
      expect(screen.getAllByText("Second Session").length).toBe(2);
    });
  });

  it("toggles file tree visibility when file tree button is clicked", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes("/sessions")) {
        return createMockResponse([]);
      }
      if (String(url).includes("/files")) {
        return createMockResponse(mockFiles);
      }
      return createMockResponse({});
    });

    render(
      <ProjectWorkspace
        project={untrustedProject}
        onBack={() => {}}
        onProjectUpdated={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
    });

    const toggleButton = screen.getByRole("button", { name: /toggle file explorer/i });
    fireEvent.click(toggleButton);

    await waitFor(() => {
      expect(screen.queryByText("src")).not.toBeInTheDocument();
    });

    fireEvent.click(toggleButton);

    await waitFor(() => {
      expect(screen.getByText("src")).toBeInTheDocument();
    });
  });

  it("submits a prompt message using PromptInput", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes("/sessions")) {
        return createMockResponse(mockSessions);
      }
      if (String(url).includes("/files")) {
        return createMockResponse([]);
      }
      return createMockResponse({});
    });

    render(
      <ProjectWorkspace
        project={untrustedProject}
        onBack={() => {}}
        onProjectUpdated={() => {}}
      />
    );

    await waitFor(() => {
      expect(screen.getAllByText("Initial Session").length).toBeGreaterThanOrEqual(1);
    });

    const textarea = screen.getByPlaceholderText(/ask about your project/i);
    fireEvent.change(textarea, { target: { value: "Run tests please" } });

    const form = textarea.closest("form");
    if (form) {
      fireEvent.submit(form);
    } else {
      const submitButton = screen.getByRole("button", { name: /submit/i });
      fireEvent.click(submitButton);
    }

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith({ text: "Run tests please" });
    });
  });

  it("calls onBack when back button is clicked", async () => {
    const onBack = vi.fn();
    vi.spyOn(global, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes("/sessions")) {
        return createMockResponse([]);
      }
      if (String(url).includes("/files")) {
        return createMockResponse([]);
      }
      return createMockResponse({});
    });

    render(
      <ProjectWorkspace
        project={untrustedProject}
        onBack={onBack}
        onProjectUpdated={() => {}}
      />
    );

    const backButton = await screen.findByRole("button", { name: /back to projects/i });
    fireEvent.click(backButton);

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
