"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, type UIMessage } from "ai";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskTrigger,
} from "@/components/ai-elements/task";
import {
  ArrowLeft,
  ArrowsClockwise,
  CheckCircle,
  Folder,
  FolderOpen,
  FolderPlus,
  Lock,
  LockOpen,
  Play,
  Plus,
  ShieldCheck,
  ShieldWarning,
  Terminal,
  Trash,
  XCircle,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type { StoredProject, StoredProjectSession } from "@/lib/project-service";
import { hydrateSettings, decodeModelRef, chatRequestBody } from "@/lib/settings";

const MODEL_STORAGE_KEY = "yggdrasil:model";

export function ProjectsView({ onBack }: { onBack: () => void }) {
  const [projects, setProjects] = useState<StoredProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(true);

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [projectMode, setProjectMode] = useState<"new" | "existing">("new");
  const [trustApprovalDialogOpen, setTrustApprovalDialogOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDir, setNewProjectDir] = useState("");
  const [newProjectDesc, setNewProjectDesc] = useState("");
  const [newProjectInstructions, setNewProjectInstructions] = useState("");
  const [trustImmediately, setTrustImmediately] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Folder Browser States
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserPath, setBrowserPath] = useState<string>("");
  const [browserParent, setBrowserParent] = useState<string | null>(null);
  const [browserDirs, setBrowserDirs] = useState<Array<{ name: string; path: string }>>([]);
  const [loadingDirs, setLoadingDirs] = useState(false);
  const [systemWorkspaceDir, setSystemWorkspaceDir] = useState("");

  const loadDirectories = async (targetPath?: string) => {
    try {
      setLoadingDirs(true);
      const url = targetPath
        ? `/api/projects/browse?path=${encodeURIComponent(targetPath)}`
        : `/api/projects/browse`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to browse directory");
      const data = await res.json();
      setBrowserPath(data.currentPath);
      setBrowserParent(data.parentPath);
      setBrowserDirs(data.directories ?? []);
      setSystemWorkspaceDir(data.systemWorkspacePath ?? "");
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingDirs(false);
    }
  };

  // Model state from settings
  const [model, setModel] = useState<string>("");

  useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        const stored = localStorage.getItem(MODEL_STORAGE_KEY);
        if (stored) setModel(stored);
      }
    } catch {
      // Storage unavailable or blocked
    }
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      setLoadingProjects(true);
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProjects(data.projects ?? []);
      if (!selectedProjectId && data.projects?.length > 0) {
        setSelectedProjectId(data.projects[0].id);
      }
    } catch (err) {
      console.error("Failed to load projects", err);
    } finally {
      setLoadingProjects(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  const activeProject = projects.find((p) => p.id === selectedProjectId) ?? null;

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) {
      setActionError("Project name is required.");
      return;
    }
    if (projectMode === "existing" && !newProjectDir.trim()) {
      setActionError("Directory path is required for existing projects.");
      return;
    }

    setSubmitting(true);
    setActionError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newProjectName.trim(),
          directoryPath: newProjectDir.trim() || undefined,
          description: newProjectDesc.trim() || undefined,
          customInstructions: newProjectInstructions.trim() || undefined,
          trusted: trustImmediately,
          mode: projectMode,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({ error: "Failed to create project" }));
        throw new Error(errJson.error ?? `HTTP ${res.status}`);
      }

      const { project } = await res.json();
      setProjects((prev) => [project, ...prev]);
      setSelectedProjectId(project.id);
      setCreateDialogOpen(false);
      setNewProjectName("");
      setNewProjectDir("");
      setNewProjectDesc("");
      setNewProjectInstructions("");
      setTrustImmediately(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleTrust = async (projectId: string, currentTrust: boolean) => {
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trusted: !currentTrust }),
      });
      if (!res.ok) throw new Error("Failed to update trust status");
      const { project } = await res.json();
      setProjects((prev) => prev.map((p) => (p.id === projectId ? project : p)));
      setTrustApprovalDialogOpen(false);
    } catch (err) {
      console.error(err);
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    if (!confirm("Are you sure you want to remove this project from Yggdrasil? (Files on disk will NOT be deleted)")) return;
    try {
      await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      const next = projects.filter((p) => p.id !== projectId);
      setProjects(next);
      if (selectedProjectId === projectId) {
        setSelectedProjectId(next[0]?.id ?? null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row overflow-hidden">
      {/* Left Sidebar: Projects List */}
      <div className="flex w-full md:w-80 shrink-0 flex-col border-b md:border-b-0 md:border-r bg-muted/10">
        <div className="flex items-center justify-between border-b p-3">
          <div className="flex items-center gap-2">
            <Button
              aria-label="Back to chat"
              onClick={onBack}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <ArrowLeft className="size-4" />
            </Button>
            <div className="flex items-center gap-1.5 font-semibold text-sm">
              <Folder className="size-4 text-primary" weight="fill" />
              <span>Projects</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              className="gap-1.5"
              onClick={() => {
                setActionError(null);
                setProjectMode("new");
                setCreateDialogOpen(true);
              }}
              size="sm"
              type="button"
              variant="outline"
              title="Create a new project workspace directory"
            >
              <Plus className="size-3.5" />
              New
            </Button>
            <Button
              className="gap-1.5"
              onClick={() => {
                setActionError(null);
                setProjectMode("existing");
                setCreateDialogOpen(true);
              }}
              size="sm"
              type="button"
              variant="outline"
              title="Open / import an existing project directory"
            >
              <FolderOpen className="size-3.5" />
              Open
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {projects.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">
              No projects added yet. Click &quot;New&quot; to authorize a project workspace directory.
            </div>
          ) : (
            projects.map((proj) => {
              const isSelected = proj.id === selectedProjectId;
              return (
                <div
                  key={proj.id}
                  onClick={() => setSelectedProjectId(proj.id)}
                  className={cn(
                    "flex flex-col gap-1 rounded-lg p-2.5 text-left text-xs transition-colors cursor-pointer border",
                    isSelected
                      ? "bg-accent text-accent-foreground border-primary/40 shadow-xs"
                      : "border-transparent hover:bg-muted/60"
                  )}
                >
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1.5 font-medium truncate">
                      <FolderOpen className="size-3.5 text-primary shrink-0" />
                      <span className="truncate">{proj.name}</span>
                    </div>
                    {proj.trusted ? (
                      <Badge className="border-green-600/30 bg-green-500/10 text-green-700 dark:text-green-400 gap-1 text-[10px] px-1.5 py-0" variant="outline">
                        <ShieldCheck className="size-3" weight="fill" />
                        Trusted
                      </Badge>
                    ) : (
                      <Badge className="border-amber-600/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 gap-1 text-[10px] px-1.5 py-0" variant="outline">
                        <ShieldWarning className="size-3" weight="fill" />
                        Untrusted
                      </Badge>
                    )}
                  </div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {proj.directoryPath}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right Content Area: Active Project Orchestrator */}
      <div className="flex min-w-0 flex-1 flex-col h-full overflow-hidden">
        {activeProject ? (
          <ProjectOrchestratorPane
            key={activeProject.id}
            project={activeProject}
            model={model}
            onRequestTrustApproval={() => setTrustApprovalDialogOpen(true)}
            onDeleteProject={() => handleDeleteProject(activeProject.id)}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center text-muted-foreground">
            <FolderOpen className="size-12 mb-3 text-muted-foreground/50" />
            <h3 className="text-base font-medium text-foreground">No project selected</h3>
            <p className="text-xs max-w-sm mt-1">
              Select an authorized project directory from the list or register a new workspace to start long-running full-stack harness orchestration.
            </p>
          </div>
        )}
      </div>

      {/* Create Project Modal */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {projectMode === "new" ? "Create New Project" : "Open Existing Project"}
            </DialogTitle>
            <DialogDescription>
              {projectMode === "new"
                ? "Set up a new workspace folder for full-stack autonomous coding and harness orchestration."
                : "Authorize an existing codebase directory on host to run isolated harness coding agents."}
            </DialogDescription>
          </DialogHeader>

          {/* Mode Switcher Tabs inside Modal */}
          <div className="flex rounded-md bg-muted p-1 text-xs font-medium">
            <button
              type="button"
              className={cn(
                "flex-1 rounded-sm py-1.5 transition-all text-center",
                projectMode === "new"
                  ? "bg-background text-foreground shadow-xs font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => {
                setProjectMode("new");
                setActionError(null);
              }}
            >
              Create New
            </button>
            <button
              type="button"
              className={cn(
                "flex-1 rounded-sm py-1.5 transition-all text-center",
                projectMode === "existing"
                  ? "bg-background text-foreground shadow-xs font-semibold"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => {
                setProjectMode("existing");
                setActionError(null);
              }}
            >
              Open Existing
            </button>
          </div>

          <div className="space-y-4 py-2 text-xs">
            {actionError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive">
                {actionError}
              </div>
            )}

            <div className="space-y-1">
              <label className="font-semibold text-foreground">Project Name</label>
              <Input
                placeholder="e.g. My Next.js Web App"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="font-semibold text-foreground">
                  {projectMode === "new" ? "Save Location / Directory Path" : "Existing Directory Path"}
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-6 text-[11px] gap-1 text-primary hover:text-primary"
                  onClick={() => {
                    void loadDirectories(newProjectDir || undefined);
                    setBrowserOpen(true);
                  }}
                >
                  <FolderOpen className="size-3" />
                  Browse...
                </Button>
              </div>
              <Input
                placeholder={
                  projectMode === "new"
                    ? "Leave empty for system workspace (data/projects/...) or enter custom path"
                    : "/home/user/Projects/my-app"
                }
                value={newProjectDir}
                onChange={(e) => setNewProjectDir(e.target.value)}
                className="font-mono text-xs"
              />
              <p className="text-[10px] text-muted-foreground">
                {projectMode === "new"
                  ? "Defaults to internal system workspace `data/projects/<name>`. You can also browse or enter any custom directory path."
                  : "Specify or browse to the absolute path of your existing codebase."}
              </p>
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-foreground">Description (Optional)</label>
              <Input
                placeholder="Brief summary of what this project does"
                value={newProjectDesc}
                onChange={(e) => setNewProjectDesc(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <label className="font-semibold text-foreground">Custom Instructions (Optional)</label>
              <Textarea
                placeholder="e.g. Always use pnpm, enforce strict TypeScript, adhere to project conventions..."
                value={newProjectInstructions}
                onChange={(e) => setNewProjectInstructions(e.target.value)}
                rows={3}
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="trust-now"
                checked={trustImmediately}
                onChange={(e) => setTrustImmediately(e.target.checked)}
                className="size-4 rounded border-input text-primary"
              />
              <label htmlFor="trust-now" className="text-xs text-foreground cursor-pointer">
                Trust this directory now (allow bash commands &amp; full file access)
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleCreateProject}
              disabled={submitting}
            >
              {submitting
                ? projectMode === "new"
                  ? "Creating..."
                  : "Opening..."
                : projectMode === "new"
                ? "Create Project"
                : "Open Project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Directory Browser Modal */}
      <Dialog open={browserOpen} onOpenChange={setBrowserOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Folder className="size-5 text-primary" weight="fill" />
              Browse Folder Location
            </DialogTitle>
            <DialogDescription>
              Select a directory on your system to authorize or save the project.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 p-2 font-mono text-[11px]">
              <span className="truncate text-foreground font-semibold">{browserPath}</span>
              {browserParent && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="h-6 text-[10px] shrink-0"
                  onClick={() => void loadDirectories(browserParent)}
                >
                  Up ⮤
                </Button>
              )}
            </div>

            {systemWorkspaceDir && (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  className="h-6 text-[10px] gap-1"
                  onClick={() => void loadDirectories(systemWorkspaceDir)}
                >
                  <Folder className="size-3 text-primary" />
                  Go to System Workspace (data/projects)
                </Button>
              </div>
            )}

            <div className="rounded-md border h-52 overflow-y-auto p-1 space-y-0.5">
              {loadingDirs ? (
                <div className="p-4 text-center text-muted-foreground text-xs">
                  Loading directory contents...
                </div>
              ) : browserDirs.length === 0 ? (
                <div className="p-4 text-center text-muted-foreground text-xs">
                  No subdirectories found in this folder.
                </div>
              ) : (
                browserDirs.map((dir) => (
                  <div
                    key={dir.path}
                    className="flex items-center justify-between p-1.5 rounded hover:bg-muted/60 cursor-pointer text-xs group"
                    onClick={() => void loadDirectories(dir.path)}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <Folder className="size-3.5 text-primary shrink-0" />
                      <span className="truncate">{dir.name}</span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="h-5 px-1.5 text-[10px] opacity-0 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        setNewProjectDir(dir.path);
                        setBrowserOpen(false);
                      }}
                    >
                      Select
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setBrowserOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                setNewProjectDir(browserPath);
                setBrowserOpen(false);
              }}
            >
              Use Current Folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Trust Approval Modal */}
      {activeProject && (
        <Dialog open={trustApprovalDialogOpen} onOpenChange={setTrustApprovalDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldWarning className="size-5 text-amber-500" weight="fill" />
                Directory Trust &amp; Sandboxing Approval
              </DialogTitle>
              <DialogDescription>
                Authorizing directory access allows the AI harness agent to execute bash commands, compile projects, install packages, and write files within:
              </DialogDescription>
            </DialogHeader>

            <div className="rounded-md border bg-muted/40 p-3 font-mono text-xs break-all text-foreground my-2">
              {activeProject.directoryPath}
            </div>

            <p className="text-xs text-muted-foreground">
              Security invariant: Commands and file tools are strictly scoped to this workspace path. Do not authorize untrusted or system-critical root paths.
            </p>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setTrustApprovalDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant={activeProject.trusted ? "destructive" : "default"}
                onClick={() => handleToggleTrust(activeProject.id, activeProject.trusted)}
              >
                {activeProject.trusted ? "Revoke Trust" : "Approve & Trust Directory"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function ProjectOrchestratorPane({
  project,
  model,
  onRequestTrustApproval,
  onDeleteProject,
}: {
  project: StoredProject;
  model: string;
  onRequestTrustApproval: () => void;
  onDeleteProject: () => void;
}) {
  const [sessions, setSessions] = useState<StoredProjectSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>(() => `psess_${Date.now()}`);
  const [activeTab, setActiveTab] = useState<"chat" | "files">("chat");

  // File tree & viewer states
  const [fileTree, setFileTree] = useState<any[]>([]);
  const [loadingTree, setLoadingTree] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  const fetchFileTree = useCallback(async () => {
    try {
      setLoadingTree(true);
      const res = await fetch(`/api/projects/${project.id}/files`);
      if (res.ok) {
        const data = await res.json();
        setFileTree(data.tree ?? []);
      }
    } catch (err) {
      console.error("Failed to load file tree", err);
    } finally {
      setLoadingTree(false);
    }
  }, [project.id]);

  useEffect(() => {
    if (activeTab === "files") {
      void fetchFileTree();
    }
  }, [activeTab, fetchFileTree]);

  const handleSelectFile = async (filePath: string) => {
    try {
      setSelectedFile(filePath);
      setLoadingFile(true);
      const res = await fetch(
        `/api/projects/${project.id}/file?path=${encodeURIComponent(filePath)}`
      );
      if (res.ok) {
        const data = await res.json();
        setFileContent(data.content);
      } else {
        setFileContent("// Failed to load file content.");
      }
    } catch (err) {
      setFileContent(`// Error loading file: ${err}`);
    } finally {
      setLoadingFile(false);
    }
  };

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/projects/chat",
        body: () => {
          const chatReq = chatRequestBody(model);
          return {
            projectId: project.id,
            model: chatReq?.model,
            provider: chatReq?.provider,
          };
        },
      }),
    [project.id, model]
  );

  const {
    messages,
    sendMessage,
    status,
    stop,
  } = useChat({
    id: activeSessionId,
    transport,
    messages: activeSession?.messages ?? [],
    onFinish: ({ messages: finalMessages }) => {
      // Save session and refresh file tree
      void fetchFileTree();
      fetch(`/api/projects/${project.id}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: activeSessionId,
          title: finalMessages[0]?.parts.find((p) => p.type === "text")?.text?.slice(0, 50) || "Project Orchestration",
          messages: finalMessages,
        }),
      }).catch((err) => {
        console.warn("[projects-view] Failed to save session:", err);
      });
    },
  });

  const [input, setInput] = useState("");

  const isGenerating = status === "submitted" || status === "streaming";

  const handleSubmit = (msg: PromptInputMessage) => {
    const text = msg.text.trim();
    if (!text || isGenerating) return;
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    setInput("");
  };

  return (
    <div className="flex h-full flex-col min-h-0">
      {/* Project Topbar */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-2 bg-muted/10">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Folder className="size-5 text-primary shrink-0" weight="fill" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold truncate text-foreground">{project.name}</h2>
              <div className="font-mono text-[11px] text-muted-foreground truncate">
                {project.directoryPath}
              </div>
            </div>
          </div>

          {/* View Tab Switcher: Chat Agent vs Project Files */}
          <div className="hidden sm:flex rounded-md bg-muted p-0.5 text-xs">
            <button
              type="button"
              className={cn(
                "rounded-sm px-2.5 py-1 transition-all",
                activeTab === "chat"
                  ? "bg-background text-foreground shadow-xs font-medium"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setActiveTab("chat")}
            >
              Harness Chat
            </button>
            <button
              type="button"
              className={cn(
                "rounded-sm px-2.5 py-1 transition-all",
                activeTab === "files"
                  ? "bg-background text-foreground shadow-xs font-medium"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => setActiveTab("files")}
            >
              Files
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {project.trusted ? (
            <Button
              className="h-7 text-xs gap-1.5 text-green-700 dark:text-green-400 border-green-600/30"
              onClick={onRequestTrustApproval}
              size="sm"
              variant="outline"
            >
              <LockOpen className="size-3.5" />
              Trusted Directory
            </Button>
          ) : (
            <Button
              className="h-7 text-xs gap-1.5 text-amber-700 dark:text-amber-400 border-amber-600/30 animate-pulse"
              onClick={onRequestTrustApproval}
              size="sm"
              variant="outline"
            >
              <Lock className="size-3.5" />
              Approve Trust
            </Button>
          )}

          <Button
            aria-label="Delete project"
            onClick={onDeleteProject}
            size="icon-xs"
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive"
          >
            <Trash className="size-4" />
          </Button>
        </div>
      </div>

      {!project.trusted && (
        <div className="border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldWarning className="size-4 shrink-0" />
            <span>
              Directory not authorized. The harness agent cannot run shell tasks or modify project files until you approve directory trust.
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-xs bg-amber-500 text-white hover:bg-amber-600 border-none shrink-0"
            onClick={onRequestTrustApproval}
          >
            Approve Access
          </Button>
        </div>
      )}

      {/* Files Tab View */}
      {activeTab === "files" ? (
        <div className="flex flex-1 min-h-0 overflow-hidden divide-x">
          {/* File Explorer Tree */}
          <div className="w-64 shrink-0 overflow-y-auto p-2 bg-muted/5 text-xs space-y-1">
            <div className="flex items-center justify-between font-semibold px-2 py-1 text-muted-foreground text-[11px]">
              <span>EXPLORER</span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => void fetchFileTree()}
                title="Refresh Files"
              >
                <ArrowsClockwise className="size-3" />
              </Button>
            </div>
            {loadingTree ? (
              <div className="p-4 text-center text-muted-foreground">Loading tree...</div>
            ) : fileTree.length === 0 ? (
              <div className="p-4 text-center text-muted-foreground">No files in project root.</div>
            ) : (
              <RenderTreeNodes nodes={fileTree} onSelectFile={handleSelectFile} selectedPath={selectedFile} />
            )}
          </div>

          {/* File Code Viewer */}
          <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden bg-background">
            {selectedFile ? (
              <>
                <div className="flex items-center justify-between border-b px-4 py-1.5 bg-muted/20 font-mono text-xs text-muted-foreground">
                  <span className="truncate">{selectedFile}</span>
                </div>
                <div className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre">
                  {loadingFile ? "Loading..." : fileContent}
                </div>
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center text-xs text-muted-foreground">
                Select a file from the explorer to preview its contents.
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Chat Orchestration View */
        <>
          <Conversation className="flex-1 min-h-0">
            <ConversationContent className="p-4 space-y-4 max-w-3xl mx-auto">
              {messages.length === 0 ? (
                <ConversationEmptyState
                  title="Full-Stack Harness Orchestrator"
                  description={`Autonomous agent ready to run tests, create features, fix bugs, and manage your project in "${project.name}".`}
                />
              ) : (
                messages.map((message) => (
                  <Message
                    key={message.id}
                    from={message.role}
                    className={message.role === "assistant" ? "max-w-[75%]" : "max-w-full"}
                  >
                    <MessageContent>
                      {message.parts.map((part, index) => {
                        if (part.type === "text") {
                          return <MessageResponse key={index}>{part.text}</MessageResponse>;
                        }
                        if (isToolUIPart(part)) {
                          const showOpen =
                            part.state === "output-available" || part.state === "output-error";
                          return (
                            <Tool defaultOpen={showOpen} key={index}>
                              {part.type === "dynamic-tool" ? (
                                <ToolHeader
                                  state={part.state}
                                  toolName={part.toolName}
                                  type={part.type}
                                />
                              ) : (
                                <ToolHeader state={part.state} type={part.type} />
                              )}
                              <ToolContent>
                                {"input" in part && part.input ? (
                                  <ToolInput input={part.input} />
                                ) : null}
                                {"output" in part && part.output ? (
                                  <ToolOutput
                                    errorText={"errorText" in part ? (part.errorText as string) : undefined}
                                    output={part.output}
                                  />
                                ) : null}
                              </ToolContent>
                            </Tool>
                          );
                        }
                        return null;
                      })}
                    </MessageContent>
                  </Message>
                ))
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          {/* Prompt Input */}
          <div className="shrink-0 border-t p-3 bg-background max-w-3xl w-full mx-auto">
            <PromptInput onSubmit={handleSubmit}>
              <PromptInputBody>
                <PromptInputTextarea
                  placeholder={
                    project.trusted
                      ? `Instruct harness agent (e.g. "Run tests and refactor auth controller", "Build landing page component")...`
                      : "Approve directory trust above to enable project harness execution..."
                  }
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={!project.trusted || isGenerating}
                />
                <PromptInputFooter>
                  <PromptInputTools />
                  <PromptInputSubmit disabled={!project.trusted || !input.trim() || isGenerating} />
                </PromptInputFooter>
              </PromptInputBody>
            </PromptInput>
          </div>
        </>
      )}
    </div>
  );
}

function RenderTreeNodes({
  nodes,
  onSelectFile,
  selectedPath,
}: {
  nodes: any[];
  onSelectFile: (path: string) => void;
  selectedPath: string | null;
}) {
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => {
        if (node.isDirectory) {
          return (
            <div key={node.path} className="space-y-0.5">
              <div className="flex items-center gap-1.5 px-2 py-1 text-muted-foreground font-medium rounded hover:bg-muted/40 cursor-default">
                <Folder className="size-3.5 text-primary" weight="fill" />
                <span className="truncate">{node.name}</span>
              </div>
              {node.children && node.children.length > 0 && (
                <div className="pl-3 border-l border-border/50 ml-2">
                  <RenderTreeNodes
                    nodes={node.children}
                    onSelectFile={onSelectFile}
                    selectedPath={selectedPath}
                  />
                </div>
              )}
            </div>
          );
        }

        const isSelected = selectedPath === node.path;
        return (
          <div
            key={node.path}
            onClick={() => onSelectFile(node.path)}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer transition-colors text-[11px]",
              isSelected
                ? "bg-accent text-accent-foreground font-semibold"
                : "hover:bg-muted/60 text-foreground"
            )}
          >
            <span className="truncate">{node.name}</span>
          </div>
        );
      })}
    </div>
  );
}
