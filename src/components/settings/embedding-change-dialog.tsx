"use client";

import { ArrowsClockwise, Warning } from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";

export type RebuildProgress = {
  current: number;
  total: number;
  percent: number;
};

export function EmbeddingChangeDialog({
  modelChanged,
  rebuildBusy,
  rebuildProgress,
  rebuildError,
  onDismiss,
  onRebuild,
}: {
  /** The newly saved embedding model the server flagged, or null when closed. */
  modelChanged: string | null;
  rebuildBusy: boolean;
  rebuildProgress: RebuildProgress;
  rebuildError: string | null;
  onDismiss: () => void;
  onRebuild: () => void;
}) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open && !rebuildBusy) onDismiss();
      }}
      open={modelChanged !== null}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 text-warning mb-1">
            <Warning className="size-5 shrink-0" weight="fill" />
            <DialogTitle>Rebuild embeddings?</DialogTitle>
          </div>
          <DialogDescription>
            You changed the embedding model to &quot;{modelChanged}&quot;. Existing memory vectors were generated under the
            previous model and are no longer compatible. Rebuild the index to
            re-embed all memories under the new model.
          </DialogDescription>
        </DialogHeader>

        {/* Real-time accurate Progress Bar during active rebuild */}
        {rebuildBusy && (
          <div className="space-y-2 py-2" data-testid="rebuild-progress">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-foreground flex items-center gap-1.5">
                <ArrowsClockwise className="size-3.5 animate-spin text-primary" />
                Re-embedding memories…
              </span>
              <span className="font-mono text-muted-foreground text-[11px]">
                {rebuildProgress.total > 0
                  ? `${rebuildProgress.current} / ${rebuildProgress.total} (${rebuildProgress.percent}%)`
                  : "Preparing…"}
              </span>
            </div>
            <Progress value={rebuildProgress.percent} className="h-2 rounded-full overflow-hidden" />
          </div>
        )}

        {rebuildError && (
          <Alert variant="destructive" className="py-2 text-xs">
            <AlertTitle className="text-xs font-semibold">Rebuild Failed</AlertTitle>
            <AlertDescription className="text-xs">{rebuildError}</AlertDescription>
          </Alert>
        )}

        <DialogFooter className="mt-2 flex gap-2 sm:justify-end">
          <Button
            disabled={rebuildBusy}
            onClick={() => onDismiss()}
            type="button"
            variant="outline"
            size="sm"
          >
            Dismiss
          </Button>
          <Button
            disabled={rebuildBusy}
            onClick={() => onRebuild()}
            type="button"
            size="sm"
          >
            {rebuildBusy ? (
              <>
                <ArrowsClockwise className="size-3.5 mr-1.5 animate-spin" />
                Rebuilding…
              </>
            ) : (
              "Rebuild now"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
