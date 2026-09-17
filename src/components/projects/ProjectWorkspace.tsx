"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import type { ChatUIMessage } from "@/app/api/chat/route";
import type { StoredProject, StoredProjectSession } from "@/lib/project-service";
import { ProjectTrustBanner } from "./ProjectTrustBanner";
import { ProjectFileTree } from "./ProjectFileTree";
import { ChatMessageRow } from "@/components/chat/ChatMessageRow";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  ArrowLeft,
  Plus,
  Trash,
  Folder,
  SidebarSimple,
  ShieldCheck,
  ShieldSlash,
  ChatCircleText,
  Clock,
  WarningCircle,
} from "@phosphor-icons/react";
import { formatRelativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

export interface ProjectWorkspaceProps {
  project: StoredProject;
  onBack: () => void;
  onProjectUpdated: (project: StoredProject) => void;
}

export function ProjectWorkspace({
  project,
  onBack,
  onProjectUpdated,
}: ProjectWorkspaceProps) {
  const [sessions, setSessions] = useState<StoredProjectSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const [input, setInput] = useState("");

  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef(activeSessionId);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );

  const customTransport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/projects/chat",
        body: {
          projectId: project.id,
          sessionId: activeSessionId,
        },
      }),
    [project.id, activeSessionId]
  );

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
    error: chatError,
    regenerate,
    addToolApprovalResponse,
  } = useChat<ChatUIMessage>({
    id: activeSessionId ?? undefined,
    transport: customTransport,
    sendAutomaticallyWhen: (chatState) =>
      lastAssistantMessageIsCompleteWithToolCalls(chatState) ||
      lastAssistantMessageIsCompleteWithApprovalResponses(chatState),
    onFinish: ({ messages: finishedMessages }) => {
      const currentActiveId = activeSessionIdRef.current;
      if (currentActiveId) {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === currentActiveId
              ? { ...s, messages: finishedMessages, updatedAt: Date.now() }
              : s
          )
        );
      }
    },
  });

  const isGenerating = status === "submitted" || status === "streaming";

  // Keep sessions state synchronized when generation completes
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = status;

    if (
      (prevStatus === "streaming" || prevStatus === "submitted") &&
      status === "ready" &&
      activeSessionId
    ) {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeSessionId
            ? { ...s, messages, updatedAt: Date.now() }
            : s
        )
      );
    }
  }, [status, activeSessionId, messages]);

  const handleCreateSession = useCallback(
    async (titleOrEvent?: unknown) => {
      try {
        setIsCreatingSession(true);
        const title =
          typeof titleOrEvent === "string" && titleOrEvent.trim()
            ? titleOrEvent.trim()
            : `Session ${sessionsRef.current.length + 1}`;
        const res = await fetch(`/api/projects/${project.id}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || "Failed to create new session");
        }
        const newSession = (await res.json()) as StoredProjectSession;
        if (
          !newSession ||
          typeof newSession !== "object" ||
          Array.isArray(newSession) ||
          !newSession.id
        ) {
          return null;
        }
        setSessions((prev) => {
          if (prev.some((s) => s.id === newSession.id)) return prev;
          return [newSession, ...prev];
        });
        setActiveSessionId(newSession.id);
        setMessages([]);
        return newSession;
      } catch (err: unknown) {
        console.error("Failed to create session", err);
        return null;
      } finally {
        setIsCreatingSession(false);
      }
    },
    [project.id, setMessages]
  );

  // Fetch sessions for this project
  const fetchSessions = useCallback(async () => {
    setLoadingSessions(true);
    setSessionsError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/sessions`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to load project sessions");
      }
      const data = (await res.json()) as StoredProjectSession[];
      const sessionList = Array.isArray(data) ? data : [];

      if (sessionList.length === 0) {
        // Auto-create initial session when project has zero sessions
        await handleCreateSession();
      } else {
        setSessions(sessionList);
        setActiveSessionId((currentActive) => {
          if (currentActive && sessionList.some((s) => s.id === currentActive)) {
            return currentActive;
          }
          return sessionList[0].id;
        });
      }
    } catch (err: unknown) {
      const errorObj = err as Error;
      setSessionsError(errorObj.message || "Failed to load sessions");
    } finally {
      setLoadingSessions(false);
    }
  }, [project.id, handleCreateSession]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetchSessions is stable callback from useCallback
    void fetchSessions();
  }, [fetchSessions]);

  // Load session messages when active session changes
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }

    let isSubscribed = true;

    // Fast initial render from memory if available
    const cachedSession = sessionsRef.current.find(
      (s) => s.id === activeSessionId
    );
    if (cachedSession?.messages && cachedSession.messages.length > 0) {
      setMessages((cachedSession.messages as ChatUIMessage[]) ?? []);
    } else {
      setMessages([]);
    }

    async function loadActiveSessionDetails(sessionId: string) {
      try {
        const res = await fetch(
          `/api/projects/${project.id}/sessions/${sessionId}`
        );
        if (!res.ok) return;
        const sessionData = (await res.json()) as StoredProjectSession;
        if (isSubscribed && sessionData?.messages) {
          setMessages((sessionData.messages as ChatUIMessage[]) ?? []);
          setSessions((prev) =>
            prev.map((s) =>
              s.id === sessionData.id ? { ...s, ...sessionData } : s
            )
          );
        }
      } catch {
        // Network fetch failed, cached messages already rendered
      }
    }

    // Always fetch fresh session details from the server on session switch
    void loadActiveSessionDetails(activeSessionId);

    return () => {
      isSubscribed = false;
    };
  }, [activeSessionId, project.id, setMessages]);

  const handleDeleteSession = async (
    e: React.MouseEvent,
    sessionIdToDelete: string
  ) => {
    e.stopPropagation();

    // If generating on the session being deleted, abort the stream first
    if (isGenerating && sessionIdToDelete === activeSessionId) {
      stop();
    }

    try {
      const res = await fetch(
        `/api/projects/${project.id}/sessions/${sessionIdToDelete}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Failed to delete session");
      }

      // Compute next active session outside the updater to keep state updaters pure
      if (activeSessionId === sessionIdToDelete) {
        const remaining = sessions.filter((s) => s.id !== sessionIdToDelete);
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
      }
      setSessions((prev) => prev.filter((s) => s.id !== sessionIdToDelete));
    } catch (err: unknown) {
      console.error("Failed to delete session", err);
    }
  };

  const handleApproveTool = useCallback(
    (approvalId: string) => {
      addToolApprovalResponse({ id: approvalId, approved: true });
    },
    [addToolApprovalResponse]
  );

  const handleDenyTool = useCallback(
    (approvalId: string, reason?: string) => {
      addToolApprovalResponse({
        id: approvalId,
        approved: false,
        reason: reason ?? "User rejected",
      });
    },
    [addToolApprovalResponse]
  );

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text || isGenerating || isCreatingSession) return;

    let targetSessionId = activeSessionId;
    if (!targetSessionId) {
      const newSession = await handleCreateSession();
      if (!newSession) return;
      targetSessionId = newSession.id;
    }

    setInput("");
    await sendMessage(
      { text },
      {
        body: {
          projectId: project.id,
          sessionId: targetSessionId,
        },
      }
    );
  };

  return (
    <div className="flex h-full flex-col bg-background overflow-hidden">
      {/* Top Ambient Banner */}
      {!project.trusted && (
        <ProjectTrustBanner
          project={project}
          onProjectUpdated={onProjectUpdated}
        />
      )}

      {/* Main Workspace Layout */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Rail */}
        <aside className="w-64 border-r border-border bg-muted/10 flex flex-col shrink-0">
          {/* Project Header */}
          <div className="p-3 border-b border-border space-y-2">
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={onBack}
                aria-label="Back to projects"
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <ArrowLeft className="size-4" />
              </Button>
              <h2
                className="font-semibold text-sm truncate text-foreground flex-1"
                title={project.name}
              >
                {project.name}
              </h2>
            </div>

            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono bg-muted/40 rounded px-2 py-1 truncate">
              <Folder className="size-3 shrink-0" />
              <span className="truncate" title={project.directoryPath}>
                {project.directoryPath}
              </span>
            </div>

            <div className="flex items-center justify-between pt-1">
              {project.trusted ? (
                <Badge
                  variant="outline"
                  className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 gap-1 text-[10px] font-medium"
                >
                  <ShieldCheck className="size-3" />
                  Trusted
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 gap-1 text-[10px] font-medium"
                >
                  <ShieldSlash className="size-3" />
                  Restricted
                </Badge>
              )}

              <Button
                size="xs"
                variant="outline"
                onClick={handleCreateSession}
                disabled={isCreatingSession}
                className="text-xs h-6 px-2 gap-1"
                aria-label="New Session"
              >
                <Plus className="size-3" />
                New Session
              </Button>
            </div>
          </div>

          {/* Sessions List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Sessions ({sessions.length})
            </div>

            {loadingSessions ? (
              <div className="flex items-center justify-center py-6 text-muted-foreground">
                <Spinner className="size-4 mr-2" />
                <span className="text-xs">Loading sessions...</span>
              </div>
            ) : sessionsError ? (
              <div className="p-2 text-xs text-destructive flex flex-col gap-1">
                <div className="flex items-center gap-1">
                  <WarningCircle className="size-3.5" />
                  <span>{sessionsError}</span>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={fetchSessions}
                  className="mt-1"
                >
                  Retry
                </Button>
              </div>
            ) : sessions.length === 0 ? (
              <div className="text-center py-8 px-2 text-muted-foreground space-y-2">
                <ChatCircleText className="size-6 mx-auto text-muted-foreground/60" />
                <p className="text-xs">No active sessions.</p>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={handleCreateSession}
                  disabled={isCreatingSession}
                  className="text-xs"
                >
                  <Plus className="size-3 mr-1" />
                  Create Session
                </Button>
              </div>
            ) : (
              sessions.map((sess) => {
                const isActive = sess.id === activeSessionId;
                return (
                  <div
                    key={sess.id}
                    onClick={() => setActiveSessionId(sess.id)}
                    className={cn(
                      "group flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs cursor-pointer transition-colors select-none",
                      isActive
                        ? "bg-accent text-accent-foreground font-medium border border-border"
                        : "hover:bg-muted text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-foreground">
                        {sess.title}
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground mt-0.5">
                        <Clock className="size-2.5" />
                        <span>
                          {sess.updatedAt
                            ? formatRelativeTime(sess.updatedAt)
                            : "Just now"}
                        </span>
                      </div>
                    </div>

                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Delete session"
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-opacity shrink-0"
                      onClick={(e) => handleDeleteSession(e, sess.id)}
                    >
                      <Trash className="size-3.5" />
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Center Canvas */}
        <main className="flex-1 flex flex-col min-w-0 bg-background relative">
          {/* Canvas Top Bar */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/10 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-semibold text-xs text-foreground truncate">
                {activeSession ? activeSession.title : "No Session Selected"}
              </span>
              {activeSession && (
                <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  {messages.length} messages
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant={fileTreeOpen ? "secondary" : "ghost"}
                size="xs"
                onClick={() => setFileTreeOpen((prev) => !prev)}
                className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                aria-label="Toggle file explorer"
              >
                <SidebarSimple className="size-3.5" />
                <span>Files</span>
              </Button>
            </div>
          </div>

          {/* Conversation Feed */}
          <div className="flex-1 min-h-0 flex flex-col relative overflow-hidden">
            <Conversation className="flex-1 overflow-y-auto">
              <ConversationContent className="mx-auto max-w-4xl px-4 py-6 space-y-6">
                {messages.length === 0 ? (
                  <ConversationEmptyState
                    title={
                      activeSession
                        ? "Workspace Chat Ready"
                        : "Select or Create a Session"
                    }
                    description={
                      activeSession
                        ? "Ask questions about your codebase, request shell operations, or edit files."
                        : "Choose an existing session from the left rail or click '+ New Session' to begin."
                    }
                  />
                ) : (
                  <>
                    {messages.map((message, index) => (
                      <ChatMessageRow
                        key={message.id}
                        message={message}
                        isLastMessage={index === messages.length - 1}
                        isStreaming={
                          isGenerating && index === messages.length - 1
                        }
                        onOpenArtifact={() => {}}
                        onApproveTool={handleApproveTool}
                        onDenyTool={handleDenyTool}
                        onFeedback={() => {}}
                        onRegenerate={() => regenerate()}
                      />
                    ))}

                    {isGenerating &&
                      messages.length > 0 &&
                      messages[messages.length - 1].role === "user" && (
                        <ChatMessageRow
                          isLastMessage={true}
                          isStreaming={true}
                          key="pending-assistant-warming-up"
                          message={{
                            id: "pending-assistant-warming-up",
                            role: "assistant",
                            parts: [],
                          }}
                          onOpenArtifact={() => {}}
                          onApproveTool={handleApproveTool}
                          onDenyTool={handleDenyTool}
                          onFeedback={() => {}}
                          onRegenerate={() => regenerate()}
                        />
                      )}
                  </>
                )}
              </ConversationContent>
              <ConversationScrollButton />
            </Conversation>

            {chatError && (
              <div className="mx-auto mb-2 w-full max-w-3xl px-4">
                <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
                  <div className="flex items-center gap-2">
                    <WarningCircle className="size-4 shrink-0" />
                    <span>{chatError.message || "An error occurred."}</span>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => regenerate()}
                    className="border-destructive/30 hover:bg-destructive/20"
                  >
                    Retry
                  </Button>
                </div>
              </div>
            )}

            {/* Bottom Composer */}
            <div className="p-4 border-t border-border bg-background">
              <PromptInput
                onSubmit={handleSubmit}
                className="mx-auto max-w-3xl"
              >
                <PromptInputBody>
                  <PromptInputTextarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Ask about your project, run commands, or edit files..."
                    disabled={isGenerating || isCreatingSession}
                  />
                </PromptInputBody>
                <PromptInputFooter>
                  <PromptInputTools>
                    {isGenerating && (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Spinner className="size-3" />
                        Responding...
                      </span>
                    )}
                    {isCreatingSession && (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Spinner className="size-3" />
                        Initializing session...
                      </span>
                    )}
                  </PromptInputTools>
                  <PromptInputSubmit
                    disabled={(!input.trim() && !isGenerating) || isCreatingSession}
                    onStop={stop}
                    status={status}
                  />
                </PromptInputFooter>
              </PromptInput>
            </div>
          </div>
        </main>

        {/* Right Drawer: File Tree */}
        {fileTreeOpen && (
          <ProjectFileTree
            projectId={project.id}
            onClose={() => setFileTreeOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
