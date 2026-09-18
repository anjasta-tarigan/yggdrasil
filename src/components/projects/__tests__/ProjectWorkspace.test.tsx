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

/**
 * Point the mocked `useChat` at the genuine hook. The module-level `vi.mock`
 * stays in effect, but this `vi.fn` now delegates to the real implementation,
 * so the component under test exercises real `Chat`-instance semantics (in
 * particular the instance swap `useChat` performs when `id` changes).
 */
async function installRealUseChat() {
  const realUseChat = (
    await vi.importActual<typeof import("@ai-sdk/react")>("@ai-sdk/react")
  ).useChat;
  (
    useChat as unknown as { mockImplementation: (fn: unknown) => void }
  ).mockImplementation(realUseChat);
}

/** Type a prompt and submit the composer form. */
function submitPrompt(text: string): void {
  const textarea = screen.getByPlaceholderText(/ask about your project/i);
  fireEvent.change(textarea, { target: { value: text } });
  const form = textarea.closest("form");
  if (form) {
    fireEvent.submit(form);
  } else {
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
  }
}

/**
 * A chat `Response` whose SSE body the test drives chunk by chunk. This lets a
 * session switch be interleaved with a still-open stream — the precondition for
 * the cross-session leak regressions.
 */
function createControlledStreamResponse() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  // Set when the consumer cancels the body — i.e. the request was aborted. The
  // `useChat` fix aborts the outgoing stream on a session switch, which cancels
  // this reader; `cancelled` is the observable proof that it happened, and it
  // also lets the write helpers below become no-ops instead of throwing
  // "Controller is already closed" on a dead stream.
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  const encoder = new TextEncoder();
  return {
    get cancelled() {
      return cancelled;
    },
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    /** Enqueue one UI-message chunk as an SSE `data:` frame. */
    sendChunk(chunk: Record<string, unknown>) {
      if (cancelled) return;
      try {
        controller?.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      } catch {
        // The stream was torn down between the guard and the enqueue.
      }
    },
    /** Enqueue a raw frame (e.g. the `[DONE]` sentinel). */
    sendRaw(raw: string) {
      if (cancelled) return;
      try {
        controller?.enqueue(encoder.encode(raw));
      } catch {
        // The stream was torn down between the guard and the enqueue.
      }
    },
    close() {
      if (cancelled) return;
      try {
        controller?.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * Flush pending effects, promises, and microtasks without asserting anything.
 * Used where a test needs the workspace to reach a settled state before making
 * its own assertions (e.g. after a round-trip session switch).
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
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

  // --- Regression test with the REAL `useChat` ------------------------------
  //
  // The stateful mock above cannot see the bug this covers: `@ai-sdk/react`
  // recreates the underlying Chat instance whenever the `id` option changes
  // (`shouldRecreateChat` in its dist). On the on-demand path the first submit
  // awaits session creation, which flips `id` from undefined to the new session
  // id — discarding the instance whose `sendMessage` the submit closure already
  // captured. The POST still succeeds but the client renders nothing. Only the
  // real hook exposes that instance swap, so this case runs it for real.
  it("renders the first user message and assistant reply on the on-demand path with the real useChat", async () => {
    // The module-level mock above is in effect for the rest of the suite; this
    // test restores the genuine hook implementation on the same `vi.fn`, so the
    // component under test uses real `useChat`.
    const realUseChat = (
      await vi.importActual<typeof import("@ai-sdk/react")>("@ai-sdk/react")
    ).useChat;
    (
      useChat as unknown as { mockImplementation: (fn: unknown) => void }
    ).mockImplementation(realUseChat);

    // The component logs the deliberate initial auto-create failure by design.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const createdSession = {
      id: "sess_on_demand_real",
      projectId: untrustedProject.id,
      title: "Session 1",
      pinned: false,
      activeStreamId: null,
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };

    // Minimal valid AI SDK UI-message stream (SSE-framed JSON chunks).
    const chatStream = [
      `data: ${JSON.stringify({ type: "start" })}\n\n`,
      `data: ${JSON.stringify({ type: "text-start", id: "text-1" })}\n\n`,
      `data: ${JSON.stringify({
        type: "text-delta",
        id: "text-1",
        delta: "Assistant reply from the real hook",
      })}\n\n`,
      `data: ${JSON.stringify({ type: "text-end", id: "text-1" })}\n\n`,
      `data: ${JSON.stringify({ type: "finish" })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    // The first auto-create POST fails so the project really has zero sessions
    // when the user submits: activeSessionId is still null, forcing the submit
    // to create the session itself (the on-demand path).
    let firstPost = true;
    vi.spyOn(global, "fetch").mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr === "/api/projects/chat" && init?.method === "POST") {
          return new Response(chatStream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
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
          return createMockResponse({ ...createdSession, messages: [] });
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

    // Wait until the failed auto-create leaves the workspace session-less.
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

    // Both the optimistic user message and the streamed assistant reply must be
    // rendered — the discarded-instance bug renders neither.
    await waitFor(() => {
      expect(screen.getByText("Hello first message")).toBeInTheDocument();
      expect(
        screen.getByText("Assistant reply from the real hook")
      ).toBeInTheDocument();
    });

    expect(messageCountBadge()).toHaveTextContent("2 messages");

    consoleErrorSpy.mockRestore();
  });

  // --- Session-switch instance-state regressions ----------------------------
  //
  // `status`, `error`, and an in-flight stream's write target live on the Chat
  // *instance*, not on the `messages` array. `setMessages(...)` only replaces
  // the message list, so without the `id` option — which makes
  // `@ai-sdk/react` recreate the instance per session — a stream started in
  // session A keeps writing into whichever session is on screen, and a failed
  // send's error banner follows the user across sessions. These tests run the
  // real hook so the instance swap is exercised for real.

  const sessionA = {
    id: "sess_1",
    projectId: "proj_untrusted",
    title: "Initial Session",
    pinned: false,
    activeStreamId: null,
    createdAt: 1000,
    updatedAt: 1000,
    messages: [],
  };
  const sessionB = {
    id: "sess_2",
    projectId: "proj_untrusted",
    title: "Second Session",
    pinned: false,
    activeStreamId: null,
    createdAt: 2000,
    updatedAt: 2000,
    messages: [],
  };

  type CapturedChatPost = {
    sessionId?: string;
    messages: Array<{
      role: string;
      parts: Array<{ type: string; text?: string }>;
    }>;
  };

  /**
   * Mounts the workspace against a two-session project with the real hook, and
   * hands back the chat POST bodies plus a handle on the controllable chat
   * stream so a session switch can be interleaved with a still-open response.
   */
  function installTwoSessionHarness(
    opts: { chatFails?: boolean; seedSessionAMessages?: boolean } = {}
  ) {
    const chatPosts: CapturedChatPost[] = [];
    // One controllable stream per chat POST, in request order. Tests index into
    // this to observe each stream's `cancelled` flag and to feed chunks.
    const streams: Array<ReturnType<typeof createControlledStreamResponse>> = [];

    // When seeding, session A arrives with a persisted transcript so its
    // "Regenerate" action is reachable without a preceding send. That is the
    // path where a stream is started by `regenerate` alone — it must still be
    // registered for abort-on-switch.
    const sessionAMessages = opts.seedSessionAMessages
      ? [
          { id: "seed-user", role: "user", parts: [{ type: "text", text: "Seeded question" }] },
          {
            id: "seed-assistant",
            role: "assistant",
            parts: [{ type: "text", text: "Seeded answer" }],
          },
        ]
      : [];

    vi.spyOn(global, "fetch").mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr === "/api/projects/chat" && init?.method === "POST") {
          chatPosts.push(JSON.parse(String(init.body)) as CapturedChatPost);
          if (opts.chatFails) {
            return new Response("Model unavailable", { status: 500 });
          }
          const stream = createControlledStreamResponse();
          streams.push(stream);
          return stream.response;
        }
        if (urlStr.includes(`/sessions/${sessionA.id}`)) {
          return createMockResponse({ ...sessionA, messages: sessionAMessages });
        }
        if (urlStr.includes(`/sessions/${sessionB.id}`)) {
          return createMockResponse({ ...sessionB, messages: [] });
        }
        if (urlStr.endsWith("/sessions")) {
          return createMockResponse([sessionA, sessionB]);
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

    return { chatPosts, streams };
  }

  it("(a) does not cache session A's transcript under session B", async () => {
    // A is streaming when the user switches to B and sends there. Because the
    // hook recreates its Chat instance per session, A's abandoned stream keeps
    // running; when it finishes it must be attributed to A, not to whichever
    // session happens to be active. The abort on switch is what keeps the
    // cache write keyed to the session that started the send.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await installRealUseChat();
    const { chatPosts, streams } = installTwoSessionHarness();

    await waitFor(() => {
      expect(messageCountBadge()).toHaveTextContent("0 messages");
    });

    submitPrompt("Message from session A");
    await waitFor(() => expect(streams.length).toBe(1));
    await act(async () => {
      streams[0].sendChunk({ type: "start" });
      streams[0].sendChunk({ type: "text-start", id: "text-a" });
      streams[0].sendChunk({
        type: "text-delta",
        id: "text-a",
        delta: "Reply from session A",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Reply from session A")).toBeInTheDocument();
    });

    // Switch to B while A is still streaming, then send from B.
    fireEvent.click(screen.getByText("Second Session"));
    await waitFor(() => {
      expect(messageCountBadge()).toHaveTextContent("0 messages");
    });

    submitPrompt("Message from session B");
    await waitFor(() => expect(streams.length).toBe(2));
    await act(async () => {
      streams[1].sendChunk({ type: "start" });
      streams[1].sendChunk({ type: "text-start", id: "text-b" });
      streams[1].sendChunk({
        type: "text-delta",
        id: "text-b",
        delta: "Reply from session B",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Reply from session B")).toBeInTheDocument();
    });

    // A finishes while B is on screen. After the fix its stream was already
    // aborted on the switch, so this is a no-op; before the fix this is the
    // moment A's finished transcript is mis-attributed to B's cache.
    await act(async () => {
      streams[0].sendChunk({ type: "text-end", id: "text-a" });
      streams[0].sendChunk({ type: "finish" });
      streams[0].sendRaw("data: [DONE]\n\n");
      streams[0].close();
    });
    await act(async () => {
      streams[1].sendChunk({ type: "text-end", id: "text-b" });
      streams[1].sendChunk({ type: "finish" });
      streams[1].sendRaw("data: [DONE]\n\n");
      streams[1].close();
    });
    await settle();

    // Round-trip through A and back to B so B renders from its cache, then send
    // again from B. That request must carry only B's own conversation.
    fireEvent.click(screen.getAllByText("Initial Session")[0]);
    await settle();
    fireEvent.click(screen.getByText("Second Session"));
    await settle();

    submitPrompt("Second message from session B");
    await waitFor(() => expect(chatPosts.length).toBeGreaterThanOrEqual(3));

    const bPost = chatPosts[chatPosts.length - 1];
    expect(bPost.sessionId).toBe(sessionB.id);
    const bPostText = JSON.stringify(bPost.messages);
    expect(bPostText).toContain("Message from session B");
    expect(bPostText).toContain("Second message from session B");
    expect(bPostText).not.toContain("Reply from session A");
    expect(bPostText).not.toContain("Message from session A");

    consoleErrorSpy.mockRestore();
  });

  it("(b) never renders session A's in-flight stream into session B", async () => {
    // Same interleaving as (a), but asserted on the canvas: after B has been
    // re-rendered from its cache, A's reply must not appear there. A's own
    // transcript must still survive on A.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await installRealUseChat();
    const { streams } = installTwoSessionHarness();

    await waitFor(() => {
      expect(messageCountBadge()).toHaveTextContent("0 messages");
    });

    submitPrompt("Message from session A");
    await waitFor(() => expect(streams.length).toBe(1));
    await act(async () => {
      streams[0].sendChunk({ type: "start" });
      streams[0].sendChunk({ type: "text-start", id: "text-a" });
      streams[0].sendChunk({
        type: "text-delta",
        id: "text-a",
        delta: "Reply from session A",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Reply from session A")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Second Session"));
    await waitFor(() => {
      expect(messageCountBadge()).toHaveTextContent("0 messages");
    });

    submitPrompt("Message from session B");
    await waitFor(() => expect(streams.length).toBe(2));
    await act(async () => {
      streams[1].sendChunk({ type: "start" });
      streams[1].sendChunk({ type: "text-start", id: "text-b" });
      streams[1].sendChunk({
        type: "text-delta",
        id: "text-b",
        delta: "Reply from session B",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Reply from session B")).toBeInTheDocument();
    });

    await act(async () => {
      streams[0].sendChunk({ type: "text-end", id: "text-a" });
      streams[0].sendChunk({ type: "finish" });
      streams[0].sendRaw("data: [DONE]\n\n");
      streams[0].close();
    });
    await act(async () => {
      streams[1].sendChunk({ type: "text-end", id: "text-b" });
      streams[1].sendChunk({ type: "finish" });
      streams[1].sendRaw("data: [DONE]\n\n");
      streams[1].close();
    });
    await settle();

    // A's reply belongs to A.
    fireEvent.click(screen.getAllByText("Initial Session")[0]);
    await waitFor(() => {
      expect(messageCountBadge()).toHaveTextContent("2 messages");
      expect(screen.getByText("Reply from session A")).toBeInTheDocument();
    });

    // B's canvas holds B's conversation and nothing of A's.
    fireEvent.click(screen.getByText("Second Session"));
    await waitFor(() => {
      expect(messageCountBadge()).toHaveTextContent("2 messages");
    });
    expect(screen.getByText("Reply from session B")).toBeInTheDocument();
    expect(screen.queryByText("Reply from session A")).toBeNull();
    expect(screen.queryByText("Message from session A")).toBeNull();

    consoleErrorSpy.mockRestore();
  });

  it("(c) keeps the on-demand first message and reply without leaking the abandoned reply onward", async () => {
    // The on-demand path creates a session on submit, which flips the hook's
    // `id` mid-stream. Routing the send through `sendMessageRef` keeps the
    // optimistic user message and the streamed reply on the live instance, and
    // aborting the outgoing stream on the next switch keeps its partial reply
    // from surfacing in the newly created session.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await installRealUseChat();

    const createdSession = {
      id: "sess_on_demand_leak",
      projectId: "proj_untrusted",
      title: "Session 1",
      pinned: false,
      activeStreamId: null,
      createdAt: 1000,
      updatedAt: 1000,
      messages: [],
    };
    const laterSession = {
      id: "sess_later",
      projectId: "proj_untrusted",
      title: "Later Session",
      pinned: false,
      activeStreamId: null,
      createdAt: 3000,
      updatedAt: 3000,
      messages: [],
    };

    const streams: Array<ReturnType<typeof createControlledStreamResponse>> = [];
    let sessionPostCount = 0;
    vi.spyOn(global, "fetch").mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr === "/api/projects/chat" && init?.method === "POST") {
          const stream = createControlledStreamResponse();
          streams.push(stream);
          return stream.response;
        }
        if (urlStr.endsWith("/sessions") && init?.method === "POST") {
          sessionPostCount += 1;
          // The first (auto) create fails so the project really starts empty;
          // the submit then creates the session itself.
          if (sessionPostCount === 1) {
            return createMockResponse({ error: "Initial auto-create failed" }, false);
          }
          return createMockResponse(
            sessionPostCount === 2 ? createdSession : laterSession
          );
        }
        if (urlStr.endsWith("/sessions")) {
          return createMockResponse([]);
        }
        if (urlStr.includes(`/sessions/${createdSession.id}`)) {
          return createMockResponse({ ...createdSession, messages: [] });
        }
        if (urlStr.includes(`/sessions/${laterSession.id}`)) {
          return createMockResponse({ ...laterSession, messages: [] });
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

    submitPrompt("Hello first message");
    await waitFor(() => expect(streams.length).toBe(1));

    // The optimistic user message lands before the stream produces anything.
    await waitFor(() => {
      expect(screen.getByText("Hello first message")).toBeInTheDocument();
      expect(messageCountBadge()).toHaveTextContent("1 messages");
    });

    await act(async () => {
      streams[0].sendChunk({ type: "start" });
      streams[0].sendChunk({ type: "text-start", id: "text-od" });
      streams[0].sendChunk({
        type: "text-delta",
        id: "text-od",
        delta: "On-demand assistant reply",
      });
    });

    // Both the optimistic user message and the streamed assistant reply render.
    await waitFor(() => {
      expect(screen.getByText("Hello first message")).toBeInTheDocument();
      expect(screen.getByText("On-demand assistant reply")).toBeInTheDocument();
      expect(messageCountBadge()).toHaveTextContent("2 messages");
    });

    // Creating a second session mid-stream must abort the outgoing one.
    fireEvent.click(screen.getByRole("button", { name: /new session/i }));
    await waitFor(() => {
      expect(screen.getAllByText("Later Session")[0]).toBeInTheDocument();
    });
    expect(streams[0].cancelled).toBe(true);

    // Send in the new session and let both streams settle.
    submitPrompt("Message from the later session");
    await waitFor(() => expect(streams.length).toBe(2));
    await act(async () => {
      streams[1].sendChunk({ type: "start" });
      streams[1].sendChunk({ type: "text-start", id: "text-later" });
      streams[1].sendChunk({
        type: "text-delta",
        id: "text-later",
        delta: "Later session reply",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Later session reply")).toBeInTheDocument();
    });

    await act(async () => {
      streams[0].sendChunk({ type: "text-end", id: "text-od" });
      streams[0].sendChunk({ type: "finish" });
      streams[0].sendRaw("data: [DONE]\n\n");
      streams[0].close();
    });
    await act(async () => {
      streams[1].sendChunk({ type: "text-end", id: "text-later" });
      streams[1].sendChunk({ type: "finish" });
      streams[1].sendRaw("data: [DONE]\n\n");
      streams[1].close();
    });
    await settle();

    // Round-trip away and back so the new session renders from its cache; the
    // abandoned on-demand reply must not have leaked into it.
    fireEvent.click(screen.getByText("Session 1"));
    await settle();
    fireEvent.click(screen.getAllByText("Later Session")[0]);
    await waitFor(() => {
      expect(messageCountBadge()).toHaveTextContent("2 messages");
    });
    expect(screen.queryByText("On-demand assistant reply")).toBeNull();
    expect(screen.queryByText("Hello first message")).toBeNull();

    consoleErrorSpy.mockRestore();
  });

  it("(d) aborts the outgoing stream on a mid-stream switch and re-enables the composer", async () => {
    // Switching sessions while a response is in flight must abort that stream
    // rather than leave it running against an abandoned instance, and the new
    // session's composer must be usable immediately.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await installRealUseChat();
    const { streams } = installTwoSessionHarness();

    await waitFor(() => {
      expect(messageCountBadge()).toHaveTextContent("0 messages");
    });

    submitPrompt("Message from session A");
    await waitFor(() => expect(streams.length).toBe(1));
    await act(async () => {
      streams[0].sendChunk({ type: "start" });
      streams[0].sendChunk({ type: "text-start", id: "text-a" });
      streams[0].sendChunk({
        type: "text-delta",
        id: "text-a",
        delta: "Reply from session A",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Responding...")).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/ask about your project/i)).toBeDisabled();

    // Switch mid-stream: the outgoing stream is aborted and the new composer is
    // not blocked by it.
    fireEvent.click(screen.getByText("Second Session"));
    await waitFor(() => {
      expect(messageCountBadge()).toHaveTextContent("0 messages");
    });
    expect(streams[0].cancelled).toBe(true);
    expect(screen.queryByText("Responding...")).toBeNull();
    expect(screen.getByPlaceholderText(/ask about your project/i)).not.toBeDisabled();

    // The new session can send right away and settles back to an enabled
    // composer once its own response completes.
    submitPrompt("Message from session B");
    await waitFor(() => expect(streams.length).toBe(2));
    await act(async () => {
      streams[1].sendChunk({ type: "start" });
      streams[1].sendChunk({ type: "text-start", id: "text-b" });
      streams[1].sendChunk({
        type: "text-delta",
        id: "text-b",
        delta: "Reply from session B",
      });
      streams[1].sendChunk({ type: "text-end", id: "text-b" });
      streams[1].sendChunk({ type: "finish" });
      streams[1].sendRaw("data: [DONE]\n\n");
      streams[1].close();
    });
    await waitFor(() => {
      expect(screen.getByText("Reply from session B")).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/ask about your project/i)).not.toBeDisabled();
    });

    consoleErrorSpy.mockRestore();
  });

  it("(e) does not leave session A's error banner visible in session B", async () => {
    // `error` lives on the Chat instance, so the per-session instance swap must
    // clear a failed send's banner when the user moves to another session.
    await installRealUseChat();
    installTwoSessionHarness({ chatFails: true });

    await waitFor(() => {
      expect(messageCountBadge()).toHaveTextContent("0 messages");
    });

    submitPrompt("Message from session A");

    // The failed send surfaces the error banner with its Retry affordance.
    await waitFor(() => {
      expect(screen.getByText("Model unavailable")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Second Session"));

    await waitFor(() => {
      expect(messageCountBadge()).toHaveTextContent("0 messages");
    });
    expect(screen.queryByText("Model unavailable")).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("(f) aborts a regenerated stream when the user leaves the session", async () => {
    // `regenerate` does not go through `handleSubmit`, so it must register its
    // stream with the same abort-on-switch tracking; otherwise its transcript
    // can leak into the session the user moved to. Session A is seeded with a
    // persisted transcript so "Regenerate" is reachable without a preceding
    // send — otherwise a stale registration from an earlier send would mask a
    // missing registration here.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await installRealUseChat();
    const { streams } = installTwoSessionHarness({ seedSessionAMessages: true });

    await waitFor(() => {
      expect(screen.getByText("Seeded answer")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /regenerate/i }));
    await waitFor(() => expect(streams.length).toBe(1));
    await act(async () => {
      streams[0].sendChunk({ type: "start" });
      streams[0].sendChunk({ type: "text-start", id: "text-a2" });
      streams[0].sendChunk({
        type: "text-delta",
        id: "text-a2",
        delta: "Regenerated reply",
      });
    });
    await waitFor(() => {
      expect(screen.getByText("Responding...")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Second Session"));
    await waitFor(() => {
      expect(messageCountBadge()).toHaveTextContent("0 messages");
    });
    expect(streams[0].cancelled).toBe(true);
    expect(screen.queryByText("Responding...")).toBeNull();
    expect(screen.queryByText("Regenerated reply")).toBeNull();

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
