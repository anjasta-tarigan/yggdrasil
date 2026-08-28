"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ArrowLeft,
  ArrowsClockwise,
  CheckCircle,
  Clock,
  Play,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import type { CronJobScheduleInfo } from "@/app/api/cron/route";

export type CronJobExecution = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "completed" | "failed";
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  lockedAt: string | null;
  runAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type CronApiResponse = {
  daemonRunning: boolean;
  queueRunnerRunning: boolean;
  schedules: Record<string, string>;
  definitions: CronJobScheduleInfo[];
  recentJobs: CronJobExecution[];
};

function formatIsoLocal(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function StatusBadge({ status }: { status: CronJobExecution["status"] }) {
  switch (status) {
    case "completed":
      return (
        <Badge
          className="gap-1 border-green-600/30 bg-green-500/10 text-green-700 dark:text-green-400"
          variant="outline"
        >
          <CheckCircle className="size-3" weight="fill" />
          Completed
        </Badge>
      );
    case "processing":
      return (
        <Badge
          className="gap-1 border-blue-600/30 bg-blue-500/10 text-blue-700 dark:text-blue-400"
          variant="outline"
        >
          <ArrowsClockwise className="size-3 animate-spin" />
          Processing
        </Badge>
      );
    case "pending":
      return (
        <Badge
          className="gap-1 border-amber-600/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          variant="outline"
        >
          <Clock className="size-3" />
          Pending
        </Badge>
      );
    case "failed":
      return (
        <Badge
          className="gap-1 border-destructive/30 bg-destructive/10 text-destructive"
          variant="outline"
        >
          <XCircle className="size-3" weight="fill" />
          Failed
        </Badge>
      );
  }
}

export function CronJobsView({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<CronApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggeringPass, setTriggeringPass] = useState<string | null>(null);
  const [feedbackNote, setFeedbackNote] = useState<string | null>(null);

  const fetchCronData = useCallback(async () => {
    try {
      const res = await fetch("/api/cron", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as CronApiResponse;
      setData(json);
    } catch (err) {
      console.warn("Failed to fetch cron status", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchCronData();

    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (!cancelled) {
        void fetchCronData();
      }
    }, 5000);

    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && !document.hidden && !cancelled) {
        void fetchCronData();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      cancelled = true;
      clearInterval(interval);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [fetchCronData]);

  const handleTrigger = async (passName: string) => {
    setTriggeringPass(passName);
    setFeedbackNote(null);
    try {
      const res = await fetch("/api/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pass: passName }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = (await res.json()) as { success: boolean; jobId?: string };
      setFeedbackNote(`Successfully enqueued job ${result.jobId ?? ""}`);
      void fetchCronData();
    } catch (err) {
      setFeedbackNote(`Failed to trigger job: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTriggeringPass(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-6 md:px-6">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button
              aria-label="Back to chat"
              onClick={onBack}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ArrowLeft className="size-4" />
            </Button>
            <div>
              <h1 className="flex items-center gap-2 text-xl font-semibold">
                <Clock className="size-5 text-primary" weight="fill" />
                Cron Jobs &amp; Scheduled Tasks
              </h1>
              <p className="text-muted-foreground text-xs">
                Autonomous background maintenance schedules, dream cycles, and job queue executions.
              </p>
            </div>
          </div>

          <Button
            className="gap-1.5"
            disabled={loading}
            onClick={() => void fetchCronData()}
            size="sm"
            type="button"
            variant="outline"
          >
            <ArrowsClockwise className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
            Refresh
          </Button>
        </div>

        {/* System status banner */}
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Cron Daemon</CardTitle>
              <CardDescription className="text-xs">
                node-cron autonomous cognitive scheduler
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <span
                  className={`size-2.5 rounded-full ${
                    data?.daemonRunning ? "bg-green-500 animate-pulse" : "bg-muted-foreground"
                  }`}
                />
                <span className="text-sm font-semibold">
                  {data?.daemonRunning ? "Active & Running" : "Stopped / Inactive"}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Job Queue Runner</CardTitle>
              <CardDescription className="text-xs">
                Sequential background worker with GPU protection
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <span
                  className={`size-2.5 rounded-full ${
                    data?.queueRunnerRunning ? "bg-green-500 animate-pulse" : "bg-muted-foreground"
                  }`}
                />
                <span className="text-sm font-semibold">
                  {data?.queueRunnerRunning ? "Active & Processing" : "Stopped / Inactive"}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        {feedbackNote && (
          <div className="mb-6 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-foreground">
            <WarningCircle className="size-4 shrink-0 text-primary" />
            <span>{feedbackNote}</span>
          </div>
        )}

        {/* Scheduled Cron Jobs */}
        <div className="mb-8 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Configured Schedules
          </h2>
          <div className="grid gap-3">
            {data?.definitions.map((def) => (
              <Card key={def.passName}>
                <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm">{def.name}</span>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {data.schedules[def.passName] ?? def.schedule}
                      </code>
                    </div>
                    <p className="text-xs text-muted-foreground">{def.description}</p>
                  </div>
                  <Button
                    className="shrink-0 gap-1.5"
                    disabled={triggeringPass === def.passName}
                    onClick={() => void handleTrigger(def.passName)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Play className="size-3.5" />
                    {triggeringPass === def.passName ? "Running..." : "Run now"}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        {/* Recent Job Queue Executions */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Recent Executions ({data?.recentJobs.length ?? 0})
          </h2>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b bg-muted/40 font-medium text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2.5">Job ID</th>
                    <th className="px-3 py-2.5">Type</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Attempts</th>
                    <th className="px-3 py-2.5">Created At</th>
                    <th className="px-3 py-2.5">Updated At</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {!data || data.recentJobs.length === 0 ? (
                    <tr>
                      <td
                        className="px-3 py-6 text-center text-muted-foreground"
                        colSpan={6}
                      >
                        No recent job queue records found.
                      </td>
                    </tr>
                  ) : (
                    data.recentJobs.map((job) => (
                      <tr className="hover:bg-muted/20" key={job.id}>
                        <td className="px-3 py-2 font-mono text-[11px]">{job.id}</td>
                        <td className="px-3 py-2 font-medium">{job.type}</td>
                        <td className="px-3 py-2">
                          <StatusBadge status={job.status} />
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {job.attempts} / {job.maxAttempts}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {formatIsoLocal(job.createdAt)}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {formatIsoLocal(job.updatedAt)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
