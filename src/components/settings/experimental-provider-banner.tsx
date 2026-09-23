"use client";

import { useState } from "react";
import { CaretDown, CaretUp, Warning } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

/**
 * Always-visible experimental label for a web provider (Spec §10.2).
 *
 * The persistent copy and the experimental label are fixed by the spec: the
 * disclosure only expands the limitations text, it never hides the label. There
 * is no dismiss affordance for the label itself.
 */
export function ExperimentalProviderBanner() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
      <div className="flex items-start gap-2">
        <Warning className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-semibold">
            Experimental: DeepSeek Web uses the web interface, not the official
            API.
          </p>
          <p className="text-[11px] text-amber-900/80 dark:text-amber-200/80">
            It may stop working when DeepSeek changes its web client. Use an
            account you control. Credentials and request identity are sent to
            the configured Yggdrasil server.
          </p>
          {expanded && (
            <div className="mt-2 space-y-1 border-t border-amber-500/20 pt-2 text-[11px] text-amber-900/80 dark:text-amber-200/80">
              <p>
                This integration is unofficial and may be affected by session
                expiry, device binding, rate limits, security checks, or
                provider changes.
              </p>
              <p>
                Yggdrasil does not collect browser credentials automatically,
                upload browser profiles, or bypass provider security controls.
                Session credentials cannot be refreshed automatically.
              </p>
            </div>
          )}
        </div>
        <Button
          aria-expanded={expanded}
          className="min-h-11 shrink-0 px-2 text-xs text-amber-800 hover:bg-amber-500/20 dark:text-amber-300"
          onClick={() => setExpanded((current) => !current)}
          size="xs"
          type="button"
          variant="ghost"
        >
          {expanded ? (
            <CaretUp className="size-3" />
          ) : (
            <CaretDown className="size-3" />
          )}
          {expanded ? "Hide limitations" : "View limitations"}
        </Button>
      </div>
    </div>
  );
}
