import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProjectWorkspace } from "../ProjectWorkspace";
import type { StoredProject } from "@/lib/project-service";
import { useChat } from "@ai-sdk/react";

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
  vi.mocked(useChat).mockReturnValue({
    id: "sess_mock",
    messages: [],
    sendMessage: mockSendMessage,
    setMessages: mockSetMessages,
    status: "ready",
    stop: mockStop,
    error: null,
    regenerate: vi.fn(),
    addToolResult: vi.fn(),
    addToolApprovalResponse: mockAddToolApprovalResponse,
  } as unknown as ReturnType<typeof useChat>);
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
      expect(mockSendMessage).toHaveBeenCalledWith(
        { text: "Run tests please" },
        {
          body: {
            projectId: untrustedProject.id,
            sessionId: "sess_1",
          },
        }
      );
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

  it("auto-creates an initial session when a project has zero sessions", async () => {
    const createdSession = {
      id: "sess_auto_1",
      projectId: untrustedProject.id,
      title: "Session 1",
      pinned: false,
      activeStreamId: null,
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };

    let postCalled = false;
    let postBody: unknown = null;

    vi.spyOn(global, "fetch").mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/sessions") && init?.method === "POST") {
          postCalled = true;
          postBody = init.body ? JSON.parse(String(init.body)) : null;
          return createMockResponse(createdSession);
        }
        if (urlStr.endsWith("/sessions")) {
          return createMockResponse([]);
        }
        if (urlStr.includes("/files")) {
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
      expect(postCalled).toBe(true);
      expect(postBody).toEqual({ title: "Session 1" });
      expect(screen.getAllByText("Session 1").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("always fetches fresh session details when switching sessions even if cached messages exist", async () => {
    const sessionsWithMessages = [
      {
        id: "sess_1",
        projectId: untrustedProject.id,
        title: "Initial Session",
        pinned: false,
        activeStreamId: null,
        createdAt: 1000,
        updatedAt: 1000,
        messages: [
          {
            id: "msg_old_1",
            role: "user",
            parts: [{ type: "text", text: "Old user message" }],
          },
        ],
      },
      {
        id: "sess_2",
        projectId: untrustedProject.id,
        title: "Second Session",
        pinned: false,
        activeStreamId: null,
        createdAt: 2000,
        updatedAt: 2000,
        messages: [
          {
            id: "msg_old_2",
            role: "user",
            parts: [{ type: "text", text: "Stale session 2 message" }],
          },
        ],
      },
    ];

    const freshSession2 = {
      ...sessionsWithMessages[1],
      messages: [
        {
          id: "msg_old_2",
          role: "user",
          parts: [{ type: "text", text: "Stale session 2 message" }],
        },
        {
          id: "msg_fresh_response",
          role: "assistant",
          parts: [{ type: "text", text: "Fresh server persisted response" }],
        },
      ],
    };

    const fetchUrls: string[] = [];

    vi.spyOn(global, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      fetchUrls.push(urlStr);

      if (urlStr.endsWith("/sessions")) {
        return createMockResponse(sessionsWithMessages);
      }
      if (urlStr.includes("/sessions/sess_1")) {
        return createMockResponse(sessionsWithMessages[0]);
      }
      if (urlStr.includes("/sessions/sess_2")) {
        return createMockResponse(freshSession2);
      }
      if (urlStr.includes("/files")) {
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
      expect(fetchUrls.some((u) => u.includes("/sessions/sess_2"))).toBe(true);
      expect(mockSetMessages).toHaveBeenCalledWith(freshSession2.messages);
    });
  });

  it("stops active generation when deleting the currently active session", async () => {
    const { useChat } = await import("@ai-sdk/react");
    vi.mocked(useChat).mockReturnValue({
      id: "sess_mock",
      messages: [],
      sendMessage: mockSendMessage,
      setMessages: mockSetMessages,
      status: "streaming",
      stop: mockStop,
      error: null,
      regenerate: vi.fn(),
      addToolResult: vi.fn(),
      addToolApprovalResponse: mockAddToolApprovalResponse,
    } as unknown as ReturnType<typeof useChat>);

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
      expect(mockStop).toHaveBeenCalledTimes(1);
    });
  });

  it("creates a session and passes targetSessionId to sendMessage if activeSessionId was null", async () => {
    // This case deliberately fails the first auto-create request to prove the
    // composer recovers; the workspace logs that failure by design.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const createdSession = {
      id: "sess_on_demand_1",
      projectId: untrustedProject.id,
      title: "Session 1",
      pinned: false,
      activeStreamId: null,
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };

    let firstPost = true;
    vi.spyOn(global, "fetch").mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/sessions") && init?.method === "POST") {
          if (firstPost) {
            firstPost = false;
            return createMockResponse({ error: "Initial auto-create failed" }, false);
          }
          return createMockResponse(createdSession);
        }
        if (urlStr.endsWith("/sessions")) {
          return createMockResponse([]);
        }
        if (urlStr.includes("/files")) {
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
      expect(screen.getByText("No active sessions.")).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText(/ask about your project/i);
    fireEvent.change(textarea, { target: { value: "Hello first message" } });

    const form = textarea.closest("form");
    if (form) {
      fireEvent.submit(form);
    } else {
      const submitButton = screen.getByRole("button", { name: /submit/i });
      fireEvent.click(submitButton);
    }

    await waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledWith(
        { text: "Hello first message" },
        {
          body: {
            projectId: untrustedProject.id,
            sessionId: "sess_on_demand_1",
          },
        }
      );
    });

    consoleErrorSpy.mockRestore();
  });
});
