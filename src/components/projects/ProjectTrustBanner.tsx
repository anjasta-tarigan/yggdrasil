"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ShieldWarning, WarningCircle } from "@phosphor-icons/react";
import { parseErrorResponse } from "@/lib/utils";
import type { StoredProject } from "@/lib/project-service";

export interface ProjectTrustBannerProps {
  project: StoredProject;
  onProjectUpdated: (project: StoredProject) => void;
}

export function ProjectTrustBanner({
  project,
  onProjectUpdated,
}: ProjectTrustBannerProps) {
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (project.trusted) {
    return null;
  }

  const handleApprove = async () => {
    setApproving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/trust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trusted: true }),
      });
      if (!res.ok) {
        throw new Error(await parseErrorResponse(res, "Failed to approve trust"));
      }
      const updated = (await res.json()) as StoredProject;
      onProjectUpdated(updated);
    } catch (err: unknown) {
      const errorObj = err as Error;
      setError(errorObj.message || "Failed to approve trust");
    } finally {
      setApproving(false);
    }
  };

  return (
    <div
      role="alert"
      className="border-b border-warning/20 bg-warning/10 px-4 py-2.5 text-warning text-xs flex flex-wrap items-center justify-between gap-3"
    >
      <div className="flex items-center gap-2 min-w-0">
        <ShieldWarning className="size-4 shrink-0" />
        <span className="font-medium">
          Directory trust required to execute shell commands and modify files.
        </span>
        {error && (
          <span className="text-destructive flex items-center gap-1 font-normal">
            <WarningCircle className="size-3.5" />
            {error}
          </span>
        )}
      </div>
      <Button
        size="xs"
        variant="outline"
        onClick={handleApprove}
        disabled={approving}
        className="shrink-0 border-warning/30 bg-warning/10 hover:bg-warning/20 text-warning font-medium"
      >
        {approving && <Spinner className="size-3 mr-1" />}
        Approve Trust
      </Button>
    </div>
  );
}
