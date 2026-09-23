"use client";

import { useState, useId } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ShieldWarning } from "@phosphor-icons/react";
import type { StoredProject } from "@/lib/project-service";

export interface ImportProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProjectCreated?: (project: StoredProject) => void;
}

export function ImportProjectDialog({
  open,
  onOpenChange,
  onProjectCreated,
}: ImportProjectDialogProps) {
  const [name, setName] = useState("");
  const [directoryPath, setDirectoryPath] = useState("");
  const [description, setDescription] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameId = useId();
  const pathId = useId();
  const descId = useId();
  const instructionsId = useId();

  const resetForm = () => {
    setName("");
    setDirectoryPath("");
    setDescription("");
    setCustomInstructions("");
    setError(null);
    setLoading(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetForm();
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Project name is required");
      return;
    }
    if (!directoryPath.trim()) {
      setError("Directory path is required");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          directoryPath: directoryPath.trim(),
          description: description.trim() || null,
          customInstructions: customInstructions.trim() || null,
          mode: "existing",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to import project");
      }

      resetForm();
      onOpenChange(false);
      onProjectCreated?.(data);
    } catch (err: unknown) {
      const errorObj = err as Error;
      setError(errorObj.message || "An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Import Existing Project</DialogTitle>
            <DialogDescription>
              Register an existing local directory as a managed project workspace.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <div
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </div>
            )}

            <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
              <div className="flex items-start gap-2">
                <ShieldWarning className="size-4 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <span className="font-medium">Restricted Access Notice</span>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Imported directories start in restricted mode. Agents can inspect
                    files in read-only mode, but mutating files or executing bash
                    commands requires explicit trust approval.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={nameId}>Project Name</Label>
              <Input
                id={nameId}
                placeholder="e.g. backend-api"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError(null);
                }}
                disabled={loading}
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={pathId}>Directory Path</Label>
              <Input
                id={pathId}
                placeholder="/absolute/path/to/project"
                value={directoryPath}
                onChange={(e) => {
                  setDirectoryPath(e.target.value);
                  if (error) setError(null);
                }}
                disabled={loading}
              />
              <p className="text-[11px] text-muted-foreground">
                Enter an absolute path to the directory on your system.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={descId}>Description (Optional)</Label>
              <Input
                id={descId}
                placeholder="Brief summary of this project"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={instructionsId}>Custom Instructions (Optional)</Label>
              <Textarea
                id={instructionsId}
                placeholder="Project-specific coding guidelines or instructions"
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                disabled={loading}
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={loading || !name.trim() || !directoryPath.trim()}
            >
              {loading && <Spinner className="size-3.5 mr-1.5" />}
              Import Project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
