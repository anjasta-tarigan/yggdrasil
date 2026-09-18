import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import * as React from "react";
import { StrictMode } from "react";
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

/**
 * Stateful `useChat` stand-in used by the race-condition tests below. Unlike
 * the plain `mockReturnValue` used by the rendering tests, this keeps real
 * message state, records the options the component passed (so tests can drive
 * `onFinish`), and appends an optimistic user message on `sendMessage` — the
 * exact shape the real hook produces.
 */
type ChatOptions = {
  id?: string;
  onFinish?: (event: { messages: unknown[] }) => void;
};

let latestChatOptions: ChatOptions | null = null;

function installStatefulChatMock() {
  latestChatOptions = null;
  (
    useChat as unknown as {
      mockImplementation: (
        fn: (options: ChatOptions) => unknown
      ) => void;
    }
  ).mockImplementation((options: ChatOptions) => {
    latestChatOptions = options;
    const [messages, setMessagesState] = React.useState<
      Array<{ id: string; role: string; parts: Array<{ type: string; text: string }> }>
    >([]);

    const setMessages = React.useCallback(
      (
        next:
          | typeof messages
          | ((prev: typeof messages) => typeof messages)
      ) => {
        setMessagesState((prev) =>
          typeof next === "function" ? next(prev) : next
        );
      },
      []
    );

    const sendMessage = React.useCallback(
      async (message: { text?: string }) => {
        setMessagesState((prev) => [
          ...prev,
          {
            id: `user-${prev.length}`,
            role: "user",
            parts: [{ type: "text", text: message?.text ?? "" }],
          },
        ]);
      },
      []
    );

    return {
      id: options?.id ?? "mock-chat",
      messages,
      sendMessage,
      setMessages,
      status: "ready",
      stop: mockStop,
      error: null,
      regenerate: vi.fn(),
      addToolResult: vi.fn(),
      addToolApprovalResponse: mockAddToolApprovalResponse,
    };
  });
}

/** The "N messages" badge rendered in the canvas top bar. */
function messageCountBadge(): HTMLElement {
  const badge = screen.getByText(/^\d+ messages$/);
  return badge;
}


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

  // --- Regression tests for session race conditions -------------------------

  it("keeps the optimistic first message when the on-demand session detail fetch resolves empty", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    installStatefulChatMock();

    const createdSession = {
      id: "sess_on_demand_keep",
      projectId: untrustedProject.id,
      title: "Session 1",
      pinned: false,
      activeStreamId: null,
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };

    // The detail endpoint deliberately resolves *after* the optimistic message
    // is on screen, and returns an empty snapshot (the server has not persisted
    // the message yet). It must not wipe local state.
    let resolveDetail: ((value: Response) => void) | null = null;
    const detailResponse = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });

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
        if (urlStr.includes(`/sessions/${createdSession.id}`)) {
          return detailResponse;
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
      fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    }

    // Optimistic user message is on screen before the detail fetch resolves.
    await waitFor(() => {
      expect(screen.getByText("Hello first message")).toBeInTheDocument();
      expect(messageCountBadge()).toHaveTextContent("1 messages");
    });

    // Now let the (empty) server snapshot land.
    await act(async () => {
      resolveDetail?.(createMockResponse({ ...createdSession, messages: [] }));
      await detailResponse;
    });

    await waitFor(() => {
      expect(screen.getByText("Hello first message")).toBeInTheDocument();
      expect(messageCountBadge()).toHaveTextContent("1 messages");
    });

    consoleErrorSpy.mockRestore();
  });

  it("ignores a superseded session detail response so it cannot overwrite current messages", async () => {
    installStatefulChatMock();

    const sessionOne = {
      id: "sess_1",
      projectId: untrustedProject.id,
      title: "Initial Session",
      pinned: false,
      activeStreamId: null,
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };

    // The initial detail request for sess_1 is held open. It was issued before
    // the user sent anything, so it is superseded the moment a send starts and
    // must be discarded when it finally resolves.
    let resolveDetail: ((value: Response) => void) | null = null;
    const detailResponse = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });

    vi.spyOn(global, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/sessions")) {
        return createMockResponse([sessionOne]);
      }
      if (urlStr.includes("/sessions/sess_1")) {
        return detailResponse;
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
      expect(screen.getAllByText("Initial Session").length).toBeGreaterThanOrEqual(1);
    });

    // Send while the detail request is still pending.
    const textarea = screen.getByPlaceholderText(/ask about your project/i);
    fireEvent.change(textarea, { target: { value: "Live message after send" } });
    const form = textarea.closest("form");
    if (form) {
      fireEvent.submit(form);
    } else {
      fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    }

    await waitFor(() => {
      expect(screen.getByText("Live message after send")).toBeInTheDocument();
      expect(messageCountBadge()).toHaveTextContent("1 messages");
    });

    // The superseded snapshot lands empty (server had nothing at request time).
    await act(async () => {
      resolveDetail?.(createMockResponse({ ...sessionOne, messages: [] }));
      await detailResponse;
    });

    expect(screen.getByText("Live message after send")).toBeInTheDocument();
    expect(messageCountBadge()).toHaveTextContent("1 messages");
  });

  it("creates exactly one session when the mount effect runs twice under StrictMode", async () => {
    installStatefulChatMock();

    let postCount = 0;
    vi.spyOn(global, "fetch").mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/sessions") && init?.method === "POST") {
          postCount++;
          return createMockResponse({
            id: `sess_auto_${postCount}`,
            projectId: untrustedProject.id,
            title: `Session ${postCount}`,
            pinned: false,
            activeStreamId: null,
            createdAt: 1000,
            updatedAt: 1000,
            messages: [],
          });
        }
        if (urlStr.endsWith("/sessions")) {
          // Empty list every time: StrictMode re-runs the mount effect, and the
          // second GET resolves before the first POST has persisted anything.
          return createMockResponse([]);
        }
        if (urlStr.includes("/files")) {
          return createMockResponse([]);
        }
        return createMockResponse({});
      }
    );

    render(
      <StrictMode>
        <ProjectWorkspace
          project={untrustedProject}
          onBack={() => {}}
          onProjectUpdated={() => {}}
        />
      </StrictMode>
    );

    await waitFor(() => {
      expect(postCount).toBeGreaterThan(0);
    });

    // Give any duplicate request time to land before asserting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(postCount).toBe(1);
  });

  it("writes the finished transcript to the originating session, not the active one", async () => {
    installStatefulChatMock();

    const sessionOne = {
      id: "sess_1",
      projectId: untrustedProject.id,
      title: "Initial Session",
      pinned: false,
      activeStreamId: null,
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };
    const sessionTwo = {
      id: "sess_2",
      projectId: untrustedProject.id,
      title: "Second Session",
      pinned: false,
      activeStreamId: null,
      createdAt: 2000,
      updatedAt: 2000,
      messages: [],
    };

    vi.spyOn(global, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/sessions")) {
        return createMockResponse([sessionOne, sessionTwo]);
      }
      // Detail endpoints stay empty so cached (local) transcripts win.
      if (urlStr.includes("/sessions/sess_1")) {
        return createMockResponse({ ...sessionOne, messages: [] });
      }
      if (urlStr.includes("/sessions/sess_2")) {
        return createMockResponse({ ...sessionTwo, messages: [] });
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
      expect(screen.getAllByText("Initial Session").length).toBeGreaterThanOrEqual(1);
    });

    // Send from session one...
    const textarea = screen.getByPlaceholderText(/ask about your project/i);
    fireEvent.change(textarea, { target: { value: "Message from session one" } });
    const form = textarea.closest("form");
    if (form) {
      fireEvent.submit(form);
    } else {
      fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    }

    await waitFor(() => {
      expect(screen.getByText("Message from session one")).toBeInTheDocument();
    });

    // ...then switch to session two before the stream finishes.
    fireEvent.click(screen.getByText("Second Session"));

    await waitFor(() => {
      expect(messageCountBadge()).toHaveTextContent("0 messages");
    });

    const finishedTranscript = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Message from session one" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Reply that belongs to session one" }],
      },
    ];

    await act(async () => {
      latestChatOptions?.onFinish?.({ messages: finishedTranscript });
    });

    // Session two must not have absorbed session one's transcript.
    expect(messageCountBadge()).toHaveTextContent("0 messages");

    // Session one's cache holds it.
    fireEvent.click(screen.getAllByText("Initial Session")[0]);

    await waitFor(() => {
      expect(messageCountBadge()).toHaveTextContent("2 messages");
    });
  });
});
