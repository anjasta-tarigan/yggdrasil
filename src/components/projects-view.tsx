"use client";

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isFileUIPart,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  Sources,
  SourcesContent,
  SourcesTrigger,
  Source,
} from "@/components/ai-elements/sources";
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardBody,
  InlineCitationCardTrigger,
  InlineCitationSource,
} from "@/components/ai-elements/inline-citation";
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Terminal,
  TerminalContent,
} from "@/components/ai-elements/terminal";
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
  ArtifactPanel,
  ARTIFACT_PANEL_EXIT_MS,
} from "@/components/artifact-panel";
import {
  ARTIFACT_TOOL,
  buildArtifactFromToolOutput,
  collectArtifacts,
  type ChatArtifact,
} from "@/lib/artifacts";
import { normalizeLatexDelimiters } from "@/lib/latex";
import {
  ArrowLeft,
  ArrowsClockwise,
  CaretDown,
  ChatCircleText,
  Folder,
  FolderOpen,
  Lock,
  LockOpen,
  Plus,
  ShieldCheck,
  ShieldWarning,
  Trash,
} from "@phosphor-icons/react";
import {
  CheckCircleIcon,
  CircleIcon,
  FileCodeIcon,
  FileTextIcon,
  LoaderCircleIcon,
  Terminal as TerminalIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { StoredProject, StoredProjectSession } from "@/lib/project-service";
import { chatRequestBody } from "@/lib/settings";

const MODEL_STORAGE_KEY = "yggdrasil:model";

function PromptInputAttachmentsDisplay() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    <Attachments variant="inline" className="px-3 pt-2">
      {attachments.files.map((attachment) => (
        <Attachment
          data={attachment}
          key={attachment.id}
          onRemove={() => attachments.remove(attachment.id)}
        >
          <AttachmentPreview />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  );
}

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

/**
 * Inline chip representing a generated deliverable or document.
 */
function ArtifactChip({
  artifact,
  errorText,
  onOpen,
}: {
  artifact?: ChatArtifact;
  errorText?: string;
  onOpen: (artifact: ChatArtifact) => void;
}) {
  if (errorText) {
    return (
      <span className="flex max-w-xs items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-2 pr-3 text-xs text-destructive">
        <FileCodeIcon className="size-4 shrink-0" />
        Artifact failed: {errorText}
      </span>
    );
  }

  const current = artifact!;
  const Icon = current.kind === "document" ? FileTextIcon : FileCodeIcon;
  return (
    <button
      aria-label={`${current.title} — ${current.kind}. ${current.description}`}
      className="flex max-w-xs items-center gap-2.5 rounded-xl border bg-muted/40 p-2 pr-3 text-left transition-colors hover:bg-muted cursor-pointer"
      onClick={() => onOpen(current)}
      type="button"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
        <Icon className="size-4 text-primary" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium text-foreground text-xs">
          {current.title}
        </span>
        <span className="block truncate text-muted-foreground text-[11px]">
          {current.description}
        </span>
      </span>
    </button>
  );
}

type TaskItemData = {
  text: string;
  status: "pending" | "in_progress" | "completed";
};

type TasksListData = {
  title?: string;
  items?: TaskItemData[];
};

const taskStatusIcon: Record<TaskItemData["status"], ReactNode> = {
  pending: <CircleIcon className="size-3.5 shrink-0 text-muted-foreground" />,
  in_progress: <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-primary" />,
  completed: <CheckCircleIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />,
};

function TaskList({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const output =
    part.state === "output-available"
      ? (part.output as TasksListData | undefined)
      : undefined;
  const input = (part.input ?? {}) as TasksListData;
  const title = output?.title ?? input.title ?? "Task Plan";
  const items = output?.items ?? input.items ?? [];
  const completed = items.filter((item) => item.status === "completed").length;

  return (
    <Task className="mb-4 w-full" defaultOpen>
      <TaskTrigger title={`${title} (${completed}/${items.length})`} />
      <TaskContent>
        {items.map((item, i) => (
          <TaskItem key={`${item.text}-${i}`}>
            <span className="inline-flex items-center gap-2 text-xs">
              {taskStatusIcon[item.status] ?? taskStatusIcon.pending}
              <span className={item.status === "completed" ? "line-through text-muted-foreground" : "text-foreground"}>
                {item.text}
              </span>
            </span>
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}

function ProjectBashTerminal({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const input = (part.input ?? {}) as { command?: string };
  const output = (part.state === "output-available" ? part.output : undefined) as
    | { stdout?: string; stderr?: string; exitCode?: number }
    | undefined;
  const isRunning =
    part.state === "input-streaming" || part.state === "input-available";

  const stdout = output?.stdout || "";
  const stderr = output?.stderr || "";
  const exitCode = output?.exitCode;

  const terminalOutput = useMemo(() => {
    let combined = "";
    if (stdout) combined += stdout;
    if (stderr) {
      if (combined && !combined.endsWith("\n")) combined += "\n";
      combined += stderr;
    }
    return combined;
  }, [stdout, stderr]);

  return (
    <div className="mb-4 overflow-hidden rounded-lg border bg-zinc-950 text-zinc-100 shadow-sm font-mono text-xs w-full">
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/90 px-3 py-2 text-xs text-zinc-300">
        <div className="flex items-center gap-2 truncate">
          <TerminalIcon className="size-3.5 text-zinc-400 shrink-0" />
          <span className="font-semibold text-emerald-400">$</span>
          <span className="truncate text-zinc-200 font-mono font-medium">
            {input.command ?? "bash"}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {exitCode !== undefined && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium font-mono",
                exitCode === 0
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                  : "bg-red-500/20 text-red-400 border border-red-500/30"
              )}
            >
              exit {exitCode}
            </span>
          )}
          {isRunning && (
            <span className="flex items-center gap-1 text-[10px] text-amber-400 animate-pulse">
              Running...
            </span>
          )}
        </div>
      </div>
      <Terminal
        className="rounded-none border-0 bg-transparent text-zinc-200"
        output={terminalOutput || (isRunning ? "Executing command..." : "No output")}
        isStreaming={isRunning}
      >
        <TerminalContent className="max-h-72 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-zinc-200" />
      </Terminal>
    </div>
  );
}

function ToolInvocation({
  part,
}: {
  part: ToolUIPart | DynamicToolUIPart;
}) {
  const showOpen =
    part.state === "output-available" || part.state === "output-error";

  return (
    <Tool defaultOpen={showOpen}>
      {part.type === "dynamic-tool" ? (
        <ToolHeader state={part.state} toolName={part.toolName} type={part.type} />
      ) : (
        <ToolHeader state={part.state} type={part.type} />
      )}
      <ToolContent>
        {"input" in part && part.input ? <ToolInput input={part.input} /> : null}
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

function MessageParts({
  message,
  isLastMessage,
  isStreaming,
  onOpenArtifact,
}: {
  message: UIMessage;
  isLastMessage: boolean;
  isStreaming: boolean;
  onOpenArtifact: (artifact: ChatArtifact) => void;
}) {
  const reasoningParts = message.parts.filter(
    (part) => part.type === "reasoning"
  );
  const reasoningText = reasoningParts.map((part) => part.text).join("\n\n");
  const hasReasoning = reasoningParts.length > 0;

  const lastPart = message.parts.at(-1);
  const isReasoningStreaming =
    isLastMessage && isStreaming && lastPart?.type === "reasoning";

  const toolParts = message.parts.filter(isToolUIPart);
  const taskParts = toolParts.filter(
    (part) => getToolName(part) === "manage_tasks"
  );
  const latestTaskPart = taskParts.at(-1);

  const artifactChips: ReactNode[] = [];
  if (message.role === "assistant") {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      if (getToolName(part) !== ARTIFACT_TOOL) continue;
      if (part.state === "output-available") {
        const built = buildArtifactFromToolOutput(part.toolCallId, part.output);
        if (built) {
          artifactChips.push(
            <ArtifactChip
              artifact={built}
              key={`chip-${part.toolCallId}`}
              onOpen={onOpenArtifact}
            />
          );
        }
      } else if (part.state === "output-error") {
        artifactChips.push(
          <ArtifactChip
            errorText={"errorText" in part ? (part.errorText as string) : undefined}
            key={`chip-${part.toolCallId}`}
            onOpen={onOpenArtifact}
          />
        );
      }
    }
  }

  const fileParts = message.parts.filter(isFileUIPart);

  // Extract sources from source-document parts or web_search tool results
  const sourcesList: Array<{ title: string; url: string; snippet?: string }> = [];
  for (const part of message.parts) {
    if (part.type === "source-document" && "source" in part && part.source) {
      const src = part.source as { title?: string; url?: string; description?: string };
      if (src.url) {
        sourcesList.push({ title: src.title ?? src.url, url: src.url, snippet: src.description });
      }
    }
  }
  for (const part of toolParts) {
    if (part.state === "output-available" && part.output && getToolName(part) === "web_search") {
      const out = part.output as { results?: Array<{ title?: string; url?: string; snippet?: string }> };
      if (Array.isArray(out.results)) {
        for (const r of out.results) {
          if (r.url && !sourcesList.some((s) => s.url === r.url)) {
            sourcesList.push({ title: r.title ?? r.url, url: r.url, snippet: r.snippet });
          }
        }
      }
    }
  }

  return (
    <>
      {sourcesList.length > 0 && (
        <Sources className="mb-3" defaultOpen={false}>
          <SourcesTrigger count={sourcesList.length} />
          <SourcesContent>
            {sourcesList.map((src, i) => (
              <Source href={src.url} key={`source-${i}`} title={src.title} />
            ))}
          </SourcesContent>
        </Sources>
      )}
      {fileParts.length > 0 && (
        <Attachments className="mb-2" variant="grid">
          {fileParts.map((file, i) => (
            <Attachment
              data={{ ...file, id: `file-${message.id}-${i}` }}
              key={`file-${message.id}-${i}`}
            >
              <AttachmentPreview />
            </Attachment>
          ))}
        </Attachments>
      )}
      {hasReasoning && (
        <Reasoning className="w-full mb-3" defaultOpen={true} isStreaming={isReasoningStreaming}>
          <ReasoningTrigger />
          <ReasoningContent>{reasoningText}</ReasoningContent>
        </Reasoning>
      )}
      {latestTaskPart && <TaskList part={latestTaskPart} />}
      {artifactChips.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">{artifactChips}</div>
      )}
      {message.parts.map((part, i) => {
        if (isToolUIPart(part)) {
          const name = getToolName(part);
          if (name === "manage_tasks" || name === ARTIFACT_TOOL) {
            return null;
          }
          if (name === "projectBash") {
            return <ProjectBashTerminal key={`${message.id}-${i}`} part={part} />;
          }
          return <ToolInvocation key={`${message.id}-${i}`} part={part} />;
        }
        switch (part.type) {
          case "text":
            return (
              <MessageResponse key={`${message.id}-${i}`}>
                {normalizeLatexDelimiters(part.text)}
              </MessageResponse>
            );
          default:
            return null;
        }
      })}
    </>
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

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${project.id}/sessions`);
      if (res.ok) {
        const data = await res.json();
        const loaded: StoredProjectSession[] = data.sessions ?? [];
        setSessions(loaded);
      }
    } catch (err) {
      console.error("Failed to load project sessions", err);
    }
  }, [project.id]);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

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
      const sessionTitle =
        finalMessages[0]?.parts.find((p) => p.type === "text")?.text?.slice(0, 50) ||
        "Project Orchestration";
      fetch(`/api/projects/${project.id}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: activeSessionId,
          title: sessionTitle,
          messages: finalMessages,
        }),
      })
        .then(() => {
          setSessions((prev) => {
            const existingIndex = prev.findIndex((s) => s.id === activeSessionId);
            const updatedSession: StoredProjectSession = {
              id: activeSessionId,
              projectId: project.id,
              title: sessionTitle,
              createdAt: existingIndex >= 0 ? prev[existingIndex].createdAt : Date.now(),
              updatedAt: Date.now(),
              messages: finalMessages,
            };
            if (existingIndex >= 0) {
              const next = [...prev];
              next[existingIndex] = updatedSession;
              return next;
            }
            return [updatedSession, ...prev];
          });
        })
        .catch((err) => {
          console.warn("[projects-view] Failed to save session:", err);
        });
    },
  });

  // ---- Artifact drawer/panel state ----
  const [openArtifact, setOpenArtifact] = useState<ChatArtifact | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [closingArtifact, setClosingArtifact] = useState<ChatArtifact | null>(null);

  const artifactIndex = useMemo(() => collectArtifacts(messages), [messages]);
  const latestArtifactItem = artifactIndex.at(-1) ?? null;
  const [seenArtifactId, setSeenArtifactId] = useState<string | null>(null);

  useEffect(() => {
    if (latestArtifactItem && latestArtifactItem.id !== seenArtifactId) {
      setSeenArtifactId(latestArtifactItem.id);
      if (!pinnedId) {
        if (closingArtifact) setClosingArtifact(null);
        setOpenArtifact(latestArtifactItem);
      }
    }
  }, [latestArtifactItem, seenArtifactId, pinnedId, closingArtifact]);

  useEffect(() => {
    if (!closingArtifact) return;
    const timer = window.setTimeout(
      () => setClosingArtifact(null),
      ARTIFACT_PANEL_EXIT_MS
    );
    return () => window.clearTimeout(timer);
  }, [closingArtifact]);

  const handleOpenArtifact = useCallback((artifact: ChatArtifact) => {
    setOpenArtifact(artifact);
    setPinnedId(artifact.id);
  }, []);

  const handleClosePanel = useCallback(() => {
    setClosingArtifact(openArtifact);
    setOpenArtifact(null);
    setPinnedId(null);
  }, [openArtifact]);

  const [input, setInput] = useState("");

  const isGenerating = status === "submitted" || status === "streaming";

  const handleSubmit = (msg: PromptInputMessage) => {
    const hasText = msg.text.trim().length > 0;
    const hasFiles = msg.files.length > 0;
    if (isGenerating || !(hasText || hasFiles)) return;
    const parts: any[] = [];
    if (hasFiles) {
      parts.push(...msg.files);
    }
    if (hasText) {
      parts.push({ type: "text", text: msg.text.trim() });
    }
    sendMessage({ role: "user", parts });
    setInput("");
  };

  const SubmitButton = () => {
    const attachments = usePromptInputAttachments();
    const hasFiles = attachments.files.length > 0;
    const hasText = input.trim().length > 0;
    return (
      <PromptInputSubmit
        disabled={!project.trusted || (!hasText && !hasFiles) || isGenerating}
        onStop={stop}
        status={status}
      />
    );
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

          {/* Session Switcher */}
          <div className="hidden md:flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5 max-w-[200px] truncate">
                  <ChatCircleText className="size-3.5 text-primary shrink-0" />
                  <span className="truncate">{activeSession?.title || "Current Session"}</span>
                  <CaretDown className="size-3 text-muted-foreground shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56 text-xs">
                <DropdownMenuItem
                  onClick={() => {
                    const newId = `psess_${Date.now()}`;
                    setActiveSessionId(newId);
                  }}
                  className="gap-2 font-medium text-primary cursor-pointer"
                >
                  <Plus className="size-3.5" />
                  New Session
                </DropdownMenuItem>
                {sessions.length > 0 && <DropdownMenuSeparator />}
                {sessions.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onClick={() => setActiveSessionId(s.id)}
                    className={cn(
                      "gap-2 cursor-pointer truncate",
                      s.id === activeSessionId && "font-semibold bg-accent"
                    )}
                  >
                    <span className="truncate">{s.title || "Untitled Session"}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
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
        <div className="flex flex-1 min-h-0 overflow-hidden relative">
          <div className="flex flex-1 flex-col min-w-0 h-full overflow-hidden">
            <Conversation className="flex-1 min-h-0">
              <ConversationContent className="p-4 space-y-4 max-w-3xl mx-auto">
                {messages.length === 0 ? (
                  <ConversationEmptyState
                    title="Full-Stack Harness Orchestrator"
                    description={`Autonomous agent ready to run tests, create features, fix bugs, and manage your project in "${project.name}".`}
                  />
                ) : (
                  messages.map((message, idx) => (
                    <Message
                      key={message.id}
                      from={message.role}
                      className={message.role === "assistant" ? "max-w-[85%]" : "max-w-full"}
                    >
                      <MessageContent>
                        <MessageParts
                          message={message}
                          isLastMessage={idx === messages.length - 1}
                          isStreaming={isGenerating}
                          onOpenArtifact={handleOpenArtifact}
                        />
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
                    <PromptInputSubmit
                      disabled={!project.trusted || (!input.trim() && !isGenerating)}
                      onStop={stop}
                      status={status}
                    />
                  </PromptInputFooter>
                </PromptInputBody>
              </PromptInput>
            </div>
          </div>

          {/* Artifact Drawer / Panel */}
          <ArtifactPanel
            artifact={openArtifact ?? closingArtifact}
            artifactCount={artifactIndex.length}
            onClose={handleClosePanel}
            open={openArtifact != null}
          />
        </div>
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
