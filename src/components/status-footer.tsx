"use client";

import React from "react";
import { Separator } from "@/components/ui/separator";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  type IconProps,
  Brain,
  CheckCircle,
  CircleNotch,
  Cpu,
  Gauge,
  Target,
  WarningCircle,
  XCircle,
  Database,
  HardDrives,
  TreeStructure,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import type {
  HealthStatus,
  ServiceHealth,
  ServiceLifecycle,
  SystemHealth,
} from "@/hooks/use-system-health";

const SYSTEM_META: Record<
  HealthStatus,
  {
    label: string;
    dot: string;
    Icon: React.ComponentType<IconProps>;
  }
> = {
  checking: { label: "Checking…", dot: "bg-muted-foreground", Icon: CircleNotch },
  ok: { label: "Operational", dot: "bg-success", Icon: CheckCircle },
  degraded: { label: "Degraded", dot: "bg-warning", Icon: WarningCircle },
  down: { label: "Offline", dot: "bg-red-500", Icon: XCircle },
};

/** Color + label mapping for the on-device service lifecycle (embedding/reranker). */
const LIFECYCLE_META: Record<
  ServiceLifecycle,
  { dot: string; text: string; label: string }
> = {
  running: { dot: "bg-success", text: "text-success", label: "Running" },
  standby: { dot: "bg-warning", text: "text-warning", label: "Standby" },
  unload: {
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    label: "Unloaded",
  },
};

const NEUTRAL_SERVICE: ServiceHealth = {
  status: "unload",
  provider: "unknown",
  model: null,
  loaded: false,
};

function getService(
  health: SystemHealth,
  key: "embedding" | "reranker"
): ServiceHealth {
  return health.services?.[key] ?? NEUTRAL_SERVICE;
}

function formatUptime(seconds?: number): string {
  if (typeof seconds !== "number" || seconds < 0) return "—";
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `${hours}h ${remMins}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h`;
}

/** A color-coded lifecycle status dot. */
function StatusDot({ status }: { status: ServiceLifecycle }) {
  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", LIFECYCLE_META[status].dot)}
      aria-hidden="true"
    />
  );
}

function SystemHealthDetails({ health }: { health: SystemHealth }) {
  const meta = SYSTEM_META[health.status];
  const db = health.subsystems?.database;
  const queue = health.subsystems?.queue;
  const daemon = health.subsystems?.daemon;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between border-b pb-2">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <TreeStructure className="size-4 text-primary" weight="bold" />
          <span>Yggdrasil Core System</span>
        </div>
        <div className="flex items-center gap-1 text-[11px]">
          <span className={cn("size-1.5 rounded-full", meta.dot)} />
          <span
            className={cn("font-medium", {
              "text-success": health.status === "ok",
              "text-warning": health.status === "degraded",
              "text-red-600 dark:text-red-400": health.status === "down",
              "text-muted-foreground": health.status === "checking",
            })}
          >
            {meta.label}
          </span>
        </div>
      </div>

      <div className="space-y-1.5 text-[11px]">
        {/* Database */}
        <div className="flex items-center justify-between rounded bg-muted/50 px-2 py-1">
          <div className="flex items-center gap-1.5">
            <Database className="size-3.5 text-muted-foreground" weight="fill" />
            <span className="font-medium text-foreground">Database (SQLite)</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            {db?.wal && (
              <span className="font-mono text-[10px] text-muted-foreground/80">WAL</span>
            )}
            {typeof db?.latencyMs === "number" && (
              <span className="font-mono tabular-nums">{db.latencyMs}ms</span>
            )}
            <span
              className={cn("size-1.5 rounded-full", {
                "bg-success": db?.status === "ok",
                "bg-warning": db?.status === "degraded",
                "bg-red-500": db?.status === "down",
                "bg-muted-foreground": !db,
              })}
            />
          </div>
        </div>

        {/* Queue Runner */}
        <div className="flex items-center justify-between rounded bg-muted/50 px-2 py-1">
          <div className="flex items-center gap-1.5">
            <HardDrives className="size-3.5 text-muted-foreground" weight="fill" />
            <span className="font-medium text-foreground">Queue Runner</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            {typeof queue?.pendingJobs === "number" && queue.pendingJobs > 0 && (
              <span className="font-mono text-[10px]">{queue.pendingJobs} pending</span>
            )}
            <span className="capitalize">{queue?.running ? "Running" : "Idle"}</span>
            <span
              className={cn("size-1.5 rounded-full", {
                "bg-success": queue?.running,
                "bg-warning": !queue?.running,
              })}
            />
          </div>
        </div>

        {/* Cognitive Daemon */}
        <div className="flex items-center justify-between rounded bg-muted/50 px-2 py-1">
          <div className="flex items-center gap-1.5">
            <TreeStructure className="size-3.5 text-muted-foreground" weight="fill" />
            <span className="font-medium text-foreground">Cognitive Daemon</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            {typeof daemon?.armedSchedules === "number" && (
              <span className="font-mono text-[10px]">{daemon.armedSchedules} schedules</span>
            )}
            <span className="capitalize">{daemon?.running ? "Armed" : "Idle"}</span>
            <span
              className={cn("size-1.5 rounded-full", {
                "bg-success": daemon?.running,
                "bg-warning": !daemon?.running,
              })}
            />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t pt-2 text-[10px] text-muted-foreground">
        <span>Uptime: {formatUptime(health.uptimeSeconds)}</span>
        {typeof health.memoryHeapMb === "number" && (
          <span>Heap: {health.memoryHeapMb}MB</span>
        )}
        {health.version && <span>v{health.version}</span>}
      </div>
    </div>
  );
}

function SystemSegment({
  health,
  model,
}: {
  health: SystemHealth;
  model: string | null;
}) {
  const meta = SYSTEM_META[health.status];
  const isChecking = health.status === "checking";
  const displayModel = model ?? health.modelId ?? null;

  return (
    <div className="flex items-center gap-3">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Inspect Yggdrasil system health"
            className="flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-muted/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            title="Click to inspect Yggdrasil system health"
          >
            <span
              className={cn("size-1.5 shrink-0 rounded-full", meta.dot)}
              aria-hidden="true"
            />
            <meta.Icon
              className={cn(
                "size-3.5",
                health.status === "ok" ? "text-success" : "text-muted-foreground",
                isChecking && "animate-spin"
              )}
              weight="fill"
              aria-label={meta.label}
            />
            <span
              className={cn("font-medium", {
                "text-success": health.status === "ok",
                "text-warning": health.status === "degraded",
                "text-red-600 dark:text-red-400": health.status === "down",
                "text-muted-foreground": isChecking,
              })}
            >
              {meta.label}
            </span>
            <span className="hidden text-muted-foreground/60 sm:inline">
              · System
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-72 p-2.5 shadow-lg"
        >
          <SystemHealthDetails health={health} />
        </PopoverContent>
      </Popover>

      {!isChecking && typeof health.latencyMs === "number" && (
        <span
          className="flex items-center gap-1 font-mono text-muted-foreground tabular-nums"
          title="Internal server roundtrip ping"
        >
          <Gauge className="size-3.5" weight="fill" />
          {health.latencyMs}ms
        </span>
      )}

      {displayModel && (
        <span
          className="hidden max-w-[200px] items-center gap-1 truncate text-muted-foreground md:flex"
          title={`Active model: ${displayModel}`}
        >
          <Cpu className="size-3.5 shrink-0" />
          <span className="truncate">{displayModel}</span>
        </span>
      )}
      {typeof health.modelCount === "number" && health.modelCount > 0 && (
        <span className="hidden text-muted-foreground lg:inline">
          {health.modelCount} models
        </span>
      )}
    </div>
  );
}

function ServiceSegment({
  label,
  service,
  icon: Icon,
}: {
  label: string;
  service: ServiceHealth;
  icon: React.ComponentType<IconProps>;
}) {
  const meta = LIFECYCLE_META[service.status];
  const detail = service.model ?? service.provider;

  return (
    <div className="flex items-center gap-1.5">
      <StatusDot status={service.status} />
      <Icon className="size-3.5 shrink-0" weight="fill" aria-hidden="true" />
      <span className="font-medium">{label}</span>
      <span className={cn("hidden sm:inline", meta.text)}>{meta.label}</span>
      {service.status !== "unload" && detail && (
        <span
          className="hidden max-w-[140px] truncate sm:inline"
          title={detail}
        >
          <span className="text-muted-foreground/60"> · </span>
          <span className="truncate">{detail}</span>
        </span>
      )}
    </div>
  );
}

export function StatusFooter({
  health,
  model,
}: {
  health: SystemHealth;
  /** Currently selected model id; falls back to the server default. */
  model: string | null;
}) {
  const embedding = getService(health, "embedding");
  const reranker = getService(health, "reranker");

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between gap-2 border-t bg-muted/40 px-3 text-xs text-muted-foreground">
      <SystemSegment health={health} model={model} />

      <div className="flex items-center gap-3">
        <ServiceSegment label="Embedding" service={embedding} icon={Brain} />
        <Separator
          orientation="vertical"
          className="mx-1 h-4 self-center"
        />
        <ServiceSegment label="Reranker" service={reranker} icon={Target} />
      </div>
    </footer>
  );
}
