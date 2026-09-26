"use client";

import { useEffect, useState } from "react";
import { ArrowCircleUp, ArrowSquareOut, X } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  channel: "release" | "main";
  releaseUrl: string | null;
  dismissed: boolean;
  releaseNotes?: string | null;
}

export function UpdateCheck() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissedLocally, setDismissedLocally] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/system/update-check", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as UpdateStatus;
        if (!cancelled) setStatus(data);
      } catch {
        // A failed probe is not an error state: the banner simply stays hidden
        // so an offline server or a 500 never blocks the About tab.
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status || !status.available || status.dismissed || dismissedLocally || !status.latest) {
    return null;
  }

  const handleDismiss = async () => {
    setDismissedLocally(true);
    try {
      await fetch("/api/system/update-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dismiss" }),
      });
    } catch {
      // Dismissal is already applied locally; the POST is best-effort so a
      // dropped request never re-surfaces a banner the user just closed.
    }
  };

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs"
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <ArrowCircleUp className="size-4 shrink-0 text-primary" weight="fill" />
        <span className="font-medium text-foreground truncate">
          Update v{status.latest} available
        </span>
        <Badge variant="outline" className="hidden sm:inline-flex text-[10px] font-mono py-0">
          installed: v{status.current}
        </Badge>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {status.releaseUrl && (
          <Button
            asChild
            size="xs"
            variant="outline"
            className="h-7 text-xs gap-1 border-primary/30 text-primary hover:bg-primary/10"
          >
            <a
              href={status.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View release on GitHub"
            >
              <span>View</span>
              <ArrowSquareOut className="size-3" />
            </a>
          </Button>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={handleDismiss}
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label="Dismiss update notification"
          title="Dismiss update"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
