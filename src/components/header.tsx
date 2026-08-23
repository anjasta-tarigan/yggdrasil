"use client";

import { cn } from "@/lib/utils";
import type { HealthStatus, SystemHealth } from "@/hooks/use-system-health";
import { Button } from "@/components/ui/button";
import {
  CheckCircle,
  CircleNotch,
  SidebarSimple,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";

const STATUS_ICON: Record<
  HealthStatus,
  { Icon: typeof CheckCircle; className: string }
> = {
  checking: { Icon: CircleNotch, className: "text-muted-foreground" },
  ok: { Icon: CheckCircle, className: "text-emerald-500" },
  degraded: { Icon: WarningCircle, className: "text-amber-500" },
  down: { Icon: XCircle, className: "text-red-500" },
};

type HeaderProps = {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  chatTitle: string | null;
  health: SystemHealth;
};

export function Header({
  sidebarOpen,
  onToggleSidebar,
  chatTitle,
  health,
}: HeaderProps) {
  const status = STATUS_ICON[health.status];
  const isChecking = health.status === "checking";

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
      <div className="flex min-w-0 items-center gap-2">
        {!sidebarOpen && (
          <Button
            aria-label="Open sidebar"
            onClick={onToggleSidebar}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <SidebarSimple className="size-4" />
          </Button>
        )}
        <h1 className="truncate text-sm font-medium">
          {chatTitle ?? "New chat"}
        </h1>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {health.modelId && (
          <span className="hidden max-w-[200px] truncate rounded-full border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground sm:inline">
            {health.modelId}
          </span>
        )}
        <span
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          title={`LLM endpoint: ${health.status}`}
        >
          <status.Icon
            className={cn("size-4", status.className, isChecking && "animate-spin")}
            weight="fill"
          />
          <span className="hidden capitalize sm:inline">{health.status}</span>
        </span>
      </div>
    </header>
  );
}
