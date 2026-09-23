"use client";

import { X } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

/**
 * Contextual acquisition help (Spec §10.3).
 *
 * Wide widths dock this as a right-side `<aside>` beside the form (the caller
 * supplies the flex container); narrow widths stack it below the form as a
 * disclosure, which is the same responsive split `artifact-panel.tsx` uses.
 *
 * It documents only the manual flow — never silent extraction, password
 * capture, profile export, or security-control bypass.
 */
export function WebProviderHelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside
      aria-label="DeepSeek Web session help"
      className="w-full rounded-lg border bg-muted/40 p-4 text-xs lg:w-80 lg:shrink-0"
    >
      <div className="flex items-center justify-between gap-2 border-b pb-2">
        <h4 className="font-semibold text-foreground">
          How to get your session token
        </h4>
        <Button
          aria-label="Close help panel"
          className="min-h-11 min-w-11"
          onClick={onClose}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="space-y-2 pt-3 text-[11px] leading-relaxed text-muted-foreground">
        <p>
          Use a session credential from your own DeepSeek Web account. Follow
          the provider&apos;s documented export or account instructions when
          available. Paste only the value requested by this form.
        </p>
        <p>
          Do not share it in screenshots, issue reports, chat messages, or logs.
          Yggdrasil does not read your browser or collect credentials
          automatically.
        </p>
        <div className="rounded border border-border bg-background p-2 font-mono text-[10px] text-foreground">
          userToken=sk-…
        </div>
      </div>
    </aside>
  );
}
