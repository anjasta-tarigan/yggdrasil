"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2Icon,
  CircleIcon,
  FileIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { sourceLabel, type SkillRow } from "@/components/skills/types";

/**
 * Minimalist skill viewer: shows skill metadata and file count.
 * Opens as a clean dialog with the skill name, status, version,
 * source, description, and total file count.
 */
export function SkillViewerDialog({
  skill,
  onClose,
}: {
  skill: SkillRow | null;
  onClose: () => void;
}) {
  const [fileCount, setFileCount] = useState<number | null>(null);

  useEffect(() => {
    if (!skill) {
      setFileCount(null);
      return;
    }

    let cancelled = false;
    fetch(`/api/skills/${skill.id}/files`)
      .then(async (res) => {
        const data = await res.json();
        if (!cancelled) {
          setFileCount(Array.isArray(data.files) ? data.files.length : 0);
        }
      })
      .catch(() => {
        if (!cancelled) setFileCount(0);
      });

    return () => {
      cancelled = true;
    };
  }, [skill]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) onClose();
    },
    [onClose]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={skill !== null}>
      <DialogContent className="max-w-md">
        {skill ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-xl">
                {skill.name}
                <Badge variant="outline" className="text-xs font-normal">
                  {skill.enabled ? (
                    <span className="flex items-center gap-1">
                      <CheckCircle2Icon className="size-3 text-success" />
                      Enabled
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <CircleIcon className="size-3 text-muted-foreground" />
                      Disabled
                    </span>
                  )}
                </Badge>
              </DialogTitle>
              <DialogDescription className="flex items-center gap-2 text-sm">
                <span>{sourceLabel(skill)}</span>
                {skill.version && (
                  <Badge variant="secondary" className="text-xs">
                    v{skill.version}
                  </Badge>
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div>
                <h4 className="text-sm font-medium text-muted-foreground">Description</h4>
                <p className="mt-1 text-sm">{skill.description || "No description provided."}</p>
              </div>

              <div>
                <h4 className="text-sm font-medium text-muted-foreground">Files</h4>
                <div className="mt-1 flex items-center gap-2 text-sm">
                  <FileIcon className="size-4" />
                  {fileCount === null ? (
                    <span className="text-muted-foreground">Loading…</span>
                  ) : (
                    <span>{fileCount} file{fileCount !== 1 ? "s" : ""}</span>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <FileIcon className="size-12 mb-2" />
            <p>Select a skill to view its details</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}