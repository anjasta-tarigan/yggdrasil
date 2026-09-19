"use client";

import { useEffect, useState, useCallback } from "react";
import { PageView } from "@/components/app-shell/page-view";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Folder,
  Plus,
  FolderSimplePlus,
  ShieldCheck,
  ShieldSlash,
  HardDrive,
  Trash,
  WarningCircle,
  ArrowsClockwise,
  ArrowRight,
  CaretLeft,
  CaretRight,
  Check,
} from "@phosphor-icons/react";
import { formatRelativeTime } from "@/lib/relative-time";
import { NewProjectDialog } from "./NewProjectDialog";
import { ImportProjectDialog } from "./ImportProjectDialog";
import type { StoredProject, PaginatedProjectsResult } from "@/lib/project-service";
import { cn, parseErrorResponse } from "@/lib/utils";

export interface ProjectsListProps {
  onSelectProject: (project: StoredProject) => void;
  activeProjectId?: string | null;
  onBack?: () => void;
}

export function ProjectsList({
  onSelectProject,
  activeProjectId,
  onBack,
}: ProjectsListProps) {
  const ITEMS_PER_PAGE = 20;

  const [projects, setProjects] = useState<StoredProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [hasPrev, setHasPrev] = useState(false);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<StoredProject | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const fetchProjects = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          page: String(currentPage),
          limit: String(ITEMS_PER_PAGE),
        });
        const res = await fetch(`/api/projects?${params}`, { signal });
        if (!res.ok) {
          throw new Error(await parseErrorResponse(res, "Failed to load projects"));
        }
        const data: PaginatedProjectsResult = await res.json();
        if (!signal?.aborted) {
          setProjects(data.projects);
          setTotalPages(data.totalPages);
          setTotalItems(data.total);
          setHasMore(data.hasMore);
          setHasPrev(data.hasPrev);
        }
      } catch (err: unknown) {
        if (signal?.aborted) return;
        const errorObj = err as Error;
        setError(errorObj.message || "Failed to load projects");
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [currentPage, ITEMS_PER_PAGE]
  );

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetchProjects is stable callback with abort signal
    void fetchProjects(controller.signal);
    return () => {
      controller.abort();
    };
  }, [fetchProjects]);

  const handleConfirmDelete = async () => {
    if (!projectToDelete) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/projects/${projectToDelete.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error(await parseErrorResponse(res, "Failed to delete project"));
      }
      const remaining = projects.filter((p) => p.id !== projectToDelete.id);
      setProjects(remaining);
      setTotalItems((prev) => prev - 1);
      // If we deleted the last project on this page, go to prev page
      if (remaining.length === 0 && currentPage > 1) {
        setCurrentPage((p) => p - 1);
      }
      setProjectToDelete(null);
    } catch (err: unknown) {
      const errorObj = err as Error;
      setError(errorObj.message || "Failed to delete project");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setIsBulkDeleting(true);
    try {
      const res = await fetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        throw new Error(await parseErrorResponse(res, "Failed to bulk delete projects"));
      }
      setProjects((prev) => prev.filter((p) => !selectedIds.has(p.id)));
      setTotalItems((prev) => prev - selectedIds.size);
      setSelectedIds(new Set());
      setBulkDeleteOpen(false);
    } catch (err: unknown) {
      const errorObj = err as Error;
      setError(errorObj.message || "Failed to bulk delete projects");
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const toggleSelection = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const handleSelectAll = () => {
    if (selectedIds.size === projects.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(projects.map((p) => p.id)));
    }
  };

  const goToPage = (page: number) => {
    if (page < 1 || page > totalPages || loading) return;
    setCurrentPage(page);
    setSelectedIds(new Set());
  };

  const handleProjectCreated = (newProject: StoredProject) => {
    setProjects((prev) => [newProject, ...prev]);
    if (currentPage === 1) {
      setTotalItems((prev) => prev + 1);
    }
    onSelectProject(newProject);
  };

  return (
    <PageView
      title="Projects"
      description="Manage workspace environments, custom directories, and agent tools"
      onBack={onBack ?? (() => {})}
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void fetchProjects()}
            disabled={loading}
            aria-label="Refresh projects"
          >
            <ArrowsClockwise className={cn("size-4", loading && "animate-spin")} />
          </Button>
          {selectedIds.size > 0 ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSelectAll}
                disabled={loading}
              >
                Clear Selection
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setBulkDeleteOpen(true)}
                disabled={isBulkDeleting}
              >
                {isBulkDeleting && <Spinner className="size-3.5 mr-1.5" />}
                Delete {selectedIds.size}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelectedIds(new Set(projects.map((p) => p.id)))}
                disabled={loading || projects.length === 0}
              >
                Select All
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setImportDialogOpen(true)}
              >
                <FolderSimplePlus className="size-4 mr-1.5" />
                Import Existing
              </Button>
              <Button
                size="sm"
                onClick={() => setNewDialogOpen(true)}
              >
                <Plus className="size-4 mr-1.5" />
                New Project
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="space-y-6">
        {error && (
          <div
            role="alert"
            className="flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
          >
            <div className="flex items-center gap-2">
              <WarningCircle className="size-4 shrink-0" />
              <span>{error}</span>
            </div>
            <Button
              variant="outline"
              size="xs"
              onClick={() => void fetchProjects()}
              className="border-destructive/30 hover:bg-destructive/20"
            >
              Retry
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-muted-foreground">
            <Spinner className="size-6" />
            <span className="text-xs">Loading projects...</span>
          </div>
        ) : projects.length === 0 && totalItems > 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-12 text-center">
            <Folder className="size-10 text-muted-foreground mb-3" />
            <h3 className="font-semibold text-base">No projects on this page</h3>
            <p className="text-muted-foreground text-sm max-w-sm mt-1 mb-4">
              There are no projects on page {currentPage}. Navigate to another page.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => goToPage(Math.min(currentPage, totalPages))}
            >
              Go to page {Math.min(currentPage, totalPages)}
            </Button>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-16 text-center">
            <div className="rounded-full bg-muted p-3 text-muted-foreground mb-3">
              <Folder className="size-8" />
            </div>
            <h3 className="font-semibold text-base">No projects found</h3>
            <p className="text-muted-foreground text-sm max-w-sm mt-1 mb-6">
              Create a new managed project workspace or import an existing project directory from disk.
            </p>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setImportDialogOpen(true)}
              >
                <FolderSimplePlus className="size-4 mr-1.5" />
                Import Existing
              </Button>
              <Button
                size="sm"
                onClick={() => setNewDialogOpen(true)}
              >
                <Plus className="size-4 mr-1.5" />
                New Project
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => {
              const isActive = project.id === activeProjectId;
              const hasMissingDisk = project.existsOnDisk === false;

              const isSelected = selectedIds.has(project.id);
              const inSelectionMode = selectedIds.size > 0;

              return (
                <Card
                  key={project.id}
                  onClick={(e) => {
                    if (inSelectionMode) {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleSelection(project.id);
                    } else {
                      onSelectProject(project);
                    }
                  }}
                  className={cn(
                    "cursor-pointer transition-all hover:border-primary/50 hover:shadow-sm flex flex-col justify-between",
                    isActive && "border-primary ring-1 ring-primary/40 bg-accent/30",
                    isSelected && "ring-2 ring-primary/40 bg-accent/30"
                  )}
                >
                  <CardContent className="p-4 space-y-3 flex-1 flex flex-col justify-between">
                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <h3 className="font-semibold text-base truncate text-foreground">
                            {project.name}
                          </h3>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {inSelectionMode && (
                            <Button
                              variant={isSelected ? "default" : "outline"}
                              size="icon-xs"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleSelection(project.id);
                              }}
                              aria-label={isSelected ? "Deselect project" : "Select project"}
                              className={cn(
                                "shrink-0",
                                isSelected
                                  ? "bg-primary text-primary-foreground"
                                  : "border-border text-muted-foreground hover:bg-accent"
                              )}
                            >
                              <Check className={cn("size-3.5", isSelected ? "opacity-100" : "opacity-0")} />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Delete project"
                            className="shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                            onClick={(e) => {
                              e.stopPropagation();
                              setProjectToDelete(project);
                            }}
                          >
                            <Trash className="size-4" />
                          </Button>
                        </div>
                      </div>

                      {project.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                          {project.description}
                        </p>
                      )}

                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono bg-muted/50 rounded px-2 py-1 truncate">
                        <Folder className="size-3 shrink-0" />
                        <span className="truncate">{project.directoryPath}</span>
                      </div>
                    </div>

                    <div className="space-y-2 pt-2 border-t border-border/60">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {project.trusted ? (
                          <Badge
                            variant="outline"
                            className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 gap-1 font-medium text-[11px]"
                          >
                            <ShieldCheck className="size-3" />
                            Trusted
                          </Badge>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge
                              variant="outline"
                              className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 gap-1 font-medium text-[11px]"
                            >
                              <ShieldSlash className="size-3" />
                              Restricted
                            </Badge>
                            <span className="text-[10px] text-muted-foreground">
                              Read-only mode until trusted
                            </span>
                          </div>
                        )}

                        {project.existsOnDisk !== undefined && (
                          project.existsOnDisk ? (
                            <Badge
                              variant="outline"
                              className="border-border text-muted-foreground gap-1 text-[11px]"
                            >
                              <HardDrive className="size-3" />
                              Available on disk
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 gap-1 text-[11px]"
                            >
                              <WarningCircle className="size-3" />
                              Missing from disk
                            </Badge>
                          )
                        )}
                      </div>

                      {hasMissingDisk && (
                        <div className="rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                          <WarningCircle className="size-3.5 shrink-0" />
                          <span>Directory path not found on disk</span>
                        </div>
                      )}

                      <div className="flex items-center justify-between pt-1 text-[11px] text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <span>Updated {formatRelativeTime(project.updatedAt)}</span>
                          {project.sessionCount !== undefined && (
                            <>
                              <span>•</span>
                              <span>
                                {project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}
                              </span>
                            </>
                          )}
                        </div>
                        <span className="flex items-center gap-1 text-foreground font-medium group-hover:text-primary">
                          Open <ArrowRight className="size-3" />
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 text-sm text-muted-foreground">
            <span>
              {totalItems} project{totalItems !== 1 ? "s" : ""} • Page {currentPage} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(1)}
                disabled={!hasPrev || loading}
                aria-label="First page"
              >
                <CaretLeft className="size-3 rotate-180" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage - 1)}
                disabled={!hasPrev || loading}
                aria-label="Previous page"
              >
                <CaretLeft className="size-3" />
              </Button>
              <span className="px-2 text-xs">
                {currentPage} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(currentPage + 1)}
                disabled={!hasMore || loading}
                aria-label="Next page"
              >
                <CaretRight className="size-3" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => goToPage(totalPages)}
                disabled={!hasMore || loading}
                aria-label="Last page"
              >
                <CaretRight className="size-3 rotate-180" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <NewProjectDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        onProjectCreated={handleProjectCreated}
      />

      <ImportProjectDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
        onProjectCreated={handleProjectCreated}
      />

      <Dialog
        open={!!projectToDelete}
        onOpenChange={(open) => !open && setProjectToDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{projectToDelete?.name}&quot;? This will remove
              the project configuration and sessions from Yggdrasil. Local files on disk will not be deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setProjectToDelete(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={isDeleting}
            >
              {isDeleting && <Spinner className="size-3.5 mr-1.5" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => !open && setBulkDeleteOpen(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {selectedIds.size} Project{selectedIds.size !== 1 ? "s" : ""}</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {selectedIds.size} project{selectedIds.size !== 1 ? "s" : ""}? This will remove the project configurations, sessions, and messages from Yggdrasil. Local files on disk will not be deleted. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              disabled={isBulkDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={isBulkDeleting}
            >
              {isBulkDeleting && <Spinner className="size-3.5 mr-1.5" />}
              Delete {selectedIds.size}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageView>
  );
}
