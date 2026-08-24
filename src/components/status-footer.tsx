"use client";

import { cn } from "@/lib/utils";
import type { HealthStatus, SystemHealth } from "@/hooks/use-system-health";
import {
  CheckCircle,
  CircleNotch,
  Cpu,
  Gauge,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";

const STATUS_META: Record<
  HealthStatus,
  { label: string; dot: string; text: string; Icon: typeof CheckCircle }
> = {
  checking: {
    label: "Checking…",
    dot: "bg-muted-foreground",
    text: "text-muted-foreground",
    Icon: CircleNotch,
  },
  ok: {
    label: "Operational",
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
    Icon: CheckCircle,
  },
  degraded: {
    label: "Degraded",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
    Icon: WarningCircle,
  },
  down: {
    label: "Offline",
    dot: "bg-red-500",
    text: "text-red-600 dark:text-red-400",
    Icon: XCircle,
  },
};

export function StatusFooter({
  health,
  model,
}: {
  health: SystemHealth;
  /** Currently selected model id; falls back to the server default. */
  model: string | null;
}) {
  const meta = STATUS_META[health.status];
  const isChecking = health.status === "checking";
  const displayModel = model ?? health.modelId;

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t bg-muted/30 px-3 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <span className={cn("size-1.5 rounded-full", meta.dot)} />
        <meta.Icon
          className={cn("size-3.5", meta.text, isChecking && "animate-spin")}
          weight="fill"
        />
        <span className={cn("font-medium", meta.text)}>{meta.label}</span>
        <span className="hidden text-muted-foreground/60 sm:inline">
          · LLM endpoint
        </span>
      </div>

      <div className="flex items-center gap-3">
        {typeof health.latencyMs === "number" && (
          <span className="flex items-center gap-1">
            <Gauge className="size-3.5" />
            {health.latencyMs}ms
          </span>
        )}
        {displayModel && (
          <span className="hidden max-w-[220px] items-center gap-1 truncate md:flex">
            <Cpu className="size-3.5 shrink-0" />
            <span className="truncate">{displayModel}</span>
          </span>
        )}
        {typeof health.modelCount === "number" && health.modelCount > 0 && (
          <span className="hidden lg:inline">{health.modelCount} models</span>
        )}
      </div>
    </footer>
  );
}
