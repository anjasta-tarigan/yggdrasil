"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCallback, useEffect, useState } from "react";
import { sourceLabel, type SkillRow } from "@/components/skills/types";

/**
 * Installed-skill file viewer: lists the bundle's files in a sidebar
 * and previews the selected one. The file list loads through the
 * files API (bounded to the preview cap server-side) whenever a skill
 * is opened; onOpenChange only handles closing (opens are programmatic).
 */
export function SkillViewerDialog({
  skill,
  onClose,
}: {
  skill: SkillRow | null;
  onClose: () => void;
}) {
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) onClose();
    },
    [onClose]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={skill !== null}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{skill?.name}</DialogTitle>
          <DialogDescription>
            {skill ? sourceLabel(skill) : ""}
          </DialogDescription>
        </DialogHeader>
        {/* Keyed per skill: opening another skill remounts the browser
            with clean state instead of resetting it in an effect. */}
        {skill && <SkillFileBrowser key={skill.id} skill={skill} />}
        {!skill && (
          <pre className="max-h-[50vh] min-w-0 flex-1 overflow-auto rounded-md bg-muted p-3 text-xs">
            Select a file to preview its content.
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * File list + preview pane for one skill. Fresh mount (keyed by skill
 * id) starts with an empty list; the effect only fetches, with all
 * state updates inside async callbacks.
 */
function SkillFileBrowser({ skill }: { skill: SkillRow }) {
  const [files, setFiles] = useState<string[]>([]);
  const [viewFile, setViewFile] = useState<{ path: string; content: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/skills/${skill.id}/files`)
      .then(async (res) => {
        const data = await res.json();
        if (!cancelled) setFiles(data.files ?? []);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [skill.id]);

  const openFile = useCallback(
    async (path: string) => {
      try {
        const res = await fetch(
          `/api/skills/${skill.id}/files?path=${encodeURIComponent(path)}`
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Read failed.");
        setViewFile({ path, content: data.content });
      } catch (err) {
        setViewFile({
          path,
          content: `// ${err instanceof Error ? err.message : "Could not read file."}`,
        });
      }
    },
    [skill.id]
  );

  return (
    <div className="flex min-h-0 flex-1 gap-3">
      <ul className="w-44 shrink-0 space-y-1 overflow-y-auto text-sm">
        {files.length === 0 && (
          <li className="text-muted-foreground text-xs">No files listed.</li>
        )}
        {files.map((file) => (
          <li key={file}>
            <button
              className={`w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-muted ${
                viewFile?.path === file ? "bg-muted font-medium" : ""
              }`}
              onClick={() => void openFile(file)}
              type="button"
            >
              {file}
            </button>
          </li>
        ))}
      </ul>
      <pre className="max-h-[50vh] min-w-0 flex-1 overflow-auto rounded-md bg-muted p-3 text-xs">
        {viewFile
          ? viewFile.content
          : "Select a file to preview its content."}
      </pre>
    </div>
  );
}
