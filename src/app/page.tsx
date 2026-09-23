"use client";

import { ChatArea } from "@/components/chat";
import { CronJobsView } from "@/components/cron-jobs-view";
import { Header } from "@/components/header";
import { McpView } from "@/components/mcp-view";
import { PluginsView } from "@/components/plugins-view";
import { ProjectsList } from "@/components/projects/ProjectsList";
import { ProjectWorkspace } from "@/components/projects/ProjectWorkspace";
import { SettingsView } from "@/components/settings-view";
import { Sidebar } from "@/components/sidebar";
import { SkillsView } from "@/components/skills-view";
import { StatisticsView } from "@/components/statistics-view";
import { StatusFooter } from "@/components/status-footer";
import { SubagentsView } from "@/components/subagents-view";
import { Spinner } from "@/components/ui/spinner";
import { useChats } from "@/hooks/use-chats";
import { useRegisteredModels, getDefaultModelRef } from "@/hooks/use-registered-models";
import { useSystemHealth } from "@/hooks/use-system-health";
import { decodeModelRef } from "@/lib/settings";
import type { StoredProject } from "@/lib/project-service";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

const MODEL_STORAGE_KEY = "yggdrasil:model";

function AppShell() {
  // Chat list ownership (hydration, background sync, mutations) lives in
  // useChats; AppShell only adds the view switch and the shell layout.
  const {
    chats,
    activeChat,
    activeChatId,
    settleChat,
    newChat,
    deleteChatById,
    deleteChatsBulkByIds,
    renameChat,
    togglePinChat,
    selectChat,
  } = useChats();
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    // Home mounts only after the hydration gate, so matchMedia is
    // always available here. Narrow viewports start collapsed — the
    // 256px sidebar would otherwise cover most of a phone's screen
    // until the user collapses it manually on every visit.
    try {
      return !window.matchMedia("(max-width: 767px)").matches;
    } catch (err) {
      console.debug(`[page] Error: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
  });
  // React to viewport crossing the md boundary: a desktop→narrow resize
  // must collapse the sidebar (a 256px panel otherwise covers a phone), but
  // an explicit user toggle while the breakpoint is steady must stand. We only
  // act when the media query flips, never on the toggle itself.
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const onChange = (event: MediaQueryListEvent) => {
      setSidebarOpen(!event.matches);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  // The selected model is lifted here so the header, footer, and the
  // prompt-input selector all stay in sync.
  const [model, setModel] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(MODEL_STORAGE_KEY);
    } catch (err) {
      console.debug(`[page] Error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  });
  const { groups, loading: modelsLoading } = useRegisteredModels();
  const health = useSystemHealth();

  // Resolve the active model ref or fall back to the registry default
  // when the stored ref is stale or null.
  const resolvedModel = useMemo(() => {
    if (modelsLoading || groups.length === 0) {
      return model;
    }
    if (model) {
      const { providerId, modelId } = decodeModelRef(model);
      const group = groups.find((g) => g.providerId === providerId);
      const exists = group?.models.some((m) => m.modelId === modelId);
      if (exists) {
        return model;
      }
    }
    return getDefaultModelRef() ?? model;
  }, [model, groups, modelsLoading]);

  const selectedModelEntry = useMemo(() => {
    const { providerId, modelId } = decodeModelRef(resolvedModel);
    return groups
      .find((group) => group.providerId === providerId)
      ?.models.find((entry) => entry.modelId === modelId) ?? null;
  }, [groups, resolvedModel]);

  const healthModelEntry = useMemo(() => {
    if (!health.modelId) return null;
    for (const group of groups) {
      const entry = group.models.find((candidate) => candidate.modelId === health.modelId);
      if (entry) return entry;
    }
    return null;
  }, [groups, health.modelId]);

  const embeddingModelLabel = useMemo(() => {
    const service = health.services?.embedding;
    if (!service) return null;
    if (service.modelDisplayName) return service.modelDisplayName;
    const modelId = service.model;
    if (!modelId) return null;
    for (const group of groups) {
      const entry = group.models.find((candidate) => candidate.modelId === modelId);
      if (entry) return entry.displayName;
    }
    return null;
  }, [groups, health.services?.embedding]);

  const rerankerModelLabel = health.services?.reranker?.model ?? null;

  const handleSelectModel = useCallback((id: string) => {
    setModel(id);
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, id);
    } catch (error) {
      console.warn("Failed to persist selected model", error);
    }
  }, []);

  // Content-area view: conversation, the in-shell Settings panel, or the
  // in-shell MCP / Skills / Plugins / Cron / Statistics / Projects pages. ChatArea stays mounted (hidden)
  // while another view is shown so an in-flight stream is not interrupted.
  // Declared before the handlers below that switch back to the chat view.
  const [view, setView] = useState<
    | "chat"
    | "projects"
    | "cron"
    | "subagents"
    | "settings"
    | "mcp"
    | "skills"
    | "plugins"
    | "statistics"
  >("chat");
  const [selectedProject, setSelectedProject] = useState<StoredProject | null>(null);

  const closeSidebarOnMobile = () => {
    try {
      if (window.matchMedia("(max-width: 767px)").matches) {
        setSidebarOpen(false);
      }
    } catch {
      // Non-browser fallback
    }
  };

  const handleNewChat = () => {
    newChat();
    setView("chat");
    closeSidebarOnMobile();
  };

  const handleSelectChat = (id: string) => {
    selectChat(id);
    setView("chat");
    closeSidebarOnMobile();
  };

  const handleOpenSettings = () => {
    setView("settings");
    closeSidebarOnMobile();
  };
  const handleCloseSettings = () => setView("chat");
  const handleOpenMcp = () => {
    setView("mcp");
    closeSidebarOnMobile();
  };
  const handleCloseMcp = () => setView("chat");
  const handleOpenSkills = () => {
    setView("skills");
    closeSidebarOnMobile();
  };
  const handleCloseSkills = () => setView("chat");
  const handleOpenPlugins = () => {
    setView("plugins");
    closeSidebarOnMobile();
  };
  const handleClosePlugins = () => setView("chat");
  const handleOpenStatistics = () => {
    setView("statistics");
    closeSidebarOnMobile();
  };
  const handleCloseStatistics = () => setView("chat");
  const handleOpenProjects = () => {
    setView("projects");
    setSelectedProject(null);
    closeSidebarOnMobile();
  };
  const handleCloseProjects = () => {
    setView("chat");
    setSelectedProject(null);
  };
  const handleOpenCron = () => {
    setView("cron");
    closeSidebarOnMobile();
  };
  const handleCloseCron = () => setView("chat");
  const handleOpenSubagents = () => {
    setView("subagents");
    closeSidebarOnMobile();
  };
  const handleCloseSubagents = () => setView("chat");
  const handleOpenChat = () => {
    setView("chat");
    closeSidebarOnMobile();
  };

  return (
    <div className="flex h-dvh flex-col">
      <a
        // Skip link: first focusable shell element, hidden until focused, jumps past the sidebar to the content.
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:border focus:border-border focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:text-foreground"
        href="#main-content"
      >
        Skip to content
      </a>
      <div className="flex min-h-0 flex-1">
        <Sidebar
          activeChatId={activeChatId}
          chatActive={view === "chat"}
          chats={chats}
          cronActive={view === "cron"}
          mcpActive={view === "mcp"}
          onDeleteChat={deleteChatById}
          onDeleteChatsBulk={deleteChatsBulkByIds}
          onNewChat={handleNewChat}
          onOpenChat={handleOpenChat}
          onOpenProjects={handleOpenProjects}
          onOpenCron={handleOpenCron}
          onOpenSubagents={handleOpenSubagents}
          onOpenMcp={handleOpenMcp}
          onOpenPlugins={handleOpenPlugins}
          onOpenSettings={handleOpenSettings}
          onOpenSkills={handleOpenSkills}
          onOpenStatistics={handleOpenStatistics}
          onRenameChat={renameChat}
          onSelect={handleSelectChat}
          onToggle={() => setSidebarOpen((prev) => !prev)}
          onTogglePinChat={togglePinChat}
          open={sidebarOpen}
          pluginsActive={view === "plugins"}
          projectsActive={view === "projects"}
          settingsActive={view === "settings"}
          skillsActive={view === "skills"}
          statisticsActive={view === "statistics"}
          subagentsActive={view === "subagents"}
        />

        <main id="main-content" className="flex min-w-0 flex-1 flex-col">
          <Header
            chatTitle={
              view === "settings"
                ? "Settings"
                : view === "mcp"
                  ? "MCP Servers"
                  : view === "skills"
                    ? "Skills"
                    : view === "plugins"
                      ? "Plugins"
                      : view === "statistics"
                        ? "Statistics"
                        : view === "cron"
                          ? "Cron Jobs"
                          : view === "subagents"
                            ? "Subagents"
                            : view === "projects"
                              ? (selectedProject ? selectedProject.name : "Projects")
                              : (activeChat?.title ?? null)
            }
            isChatView={view === "chat"}
            onToggleSidebar={() => setSidebarOpen(true)}
            sidebarOpen={sidebarOpen}
          />

          <div className="min-h-0 flex-1">
            {activeChatId && (
              <div className={cn("h-full", view !== "chat" && "hidden")}>
                <ChatArea
                  chatId={activeChatId}
                  initialMessages={activeChat?.messages ?? []}
                  key={activeChatId}
                  model={resolvedModel}
                  onSelectModel={handleSelectModel}
                  onSettled={settleChat}
                />
              </div>
            )}
            {view === "cron" && <CronJobsView onBack={handleCloseCron} />}
            {view === "subagents" && (
              <SubagentsView onBack={handleCloseSubagents} />
            )}
            {view === "projects" && !selectedProject && (
              <ProjectsList
                onSelectProject={(project) => setSelectedProject(project)}
                activeProjectId={null}
                onBack={handleCloseProjects}
              />
            )}
            {view === "projects" && selectedProject && (
              <ProjectWorkspace
                project={selectedProject}
                onBack={() => setSelectedProject(null)}
                onProjectUpdated={setSelectedProject}
              />
            )}
            {view === "settings" && <SettingsView onBack={handleCloseSettings} />}
            {view === "mcp" && <McpView onBack={handleCloseMcp} />}
            {view === "skills" && <SkillsView onBack={handleCloseSkills} />}
            {view === "plugins" && <PluginsView onBack={handleClosePlugins} />}
            {view === "statistics" && (
              <StatisticsView onBack={handleCloseStatistics} />
            )}
          </div>
          </main>
        </div>

        <StatusFooter
          health={health}
          model={decodeModelRef(resolvedModel).modelId}
          modelLabel={selectedModelEntry?.displayName ?? healthModelEntry?.displayName ?? null}
          embeddingModelLabel={embeddingModelLabel}
          rerankerModelLabel={rerankerModelLabel}
        />
      </div>
  );
}

export default function Home() {
  // Gate on mount so localStorage is only touched client-side,
  // avoiding SSR hydration mismatches. useSyncExternalStore is the
  // lint-clean way to detect hydration completion (no setState in effect).
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  if (!mounted) {
    return (
      <main className="flex h-dvh items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </main>
    );
  }

  return <AppShell />;
}
