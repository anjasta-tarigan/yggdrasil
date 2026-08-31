"use client";

import { Badge } from "@/components/ui/badge";
import { PageView } from "@/components/app-shell/page-view";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowsClockwise,
  CaretLeft,
  CaretRight,
  CheckCircle,
  Clock,
  PencilSimple,
  Play,
  Plus,
  TrashSimple,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

export type CronScheduleEntry = {
  id: string;
  name: string;
  schedule: string;
  description: string;
  jobType: string;
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  builtIn?: boolean;
};

export type SchedulableJobType = {
  jobType: string;
  label: string;
  description: string;
};

export type JobsPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type CronApiResponse = {
  daemonRunning: boolean;
  queueRunnerRunning: boolean;
  schedules: CronScheduleEntry[];
  schedulableJobTypes: SchedulableJobType[];
  recentJobs: CronJobExecution[];
  jobsPagination?: JobsPagination;
};

/** Schedules per page in the Configured Schedules section. */
const SCHEDULES_PAGE_SIZE = 5;

function clampPage(page: number, totalPages: number): number {
  return Math.min(Math.max(1, page), Math.max(1, totalPages));
}

/**
 * Compact pager: prev/next + page indicator + (optionally) numbered pages.
 * Keeps both directions of clamping predictable when total shrinks.
 */
function Pager({
  page,
  totalPages,
  onPageChange,
  itemCount,
  label,
  showNumbers = false,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  itemCount?: number;
  label: string;
  showNumbers?: boolean;
}) {
  if (totalPages <= 1) return null;
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 pt-1"
      data-testid={`pager-${label}`}
    >
      <span className="text-xs text-muted-foreground">
        {itemCount !== undefined
          ? `${itemCount} item${itemCount === 1 ? "" : "s"}`
          : null}
      </span>
      <div className="flex items-center gap-1">
        <Button
          aria-label={`Previous page of ${label}`}
          disabled={page <= 1}
          onClick={() => onPageChange(clampPage(page - 1, totalPages))}
          size="icon-sm"
          type="button"
          variant="outline"
        >
          <CaretLeft className="size-3.5" />
        </Button>
        {showNumbers ? (
          pages.map((p) => (
            <Button
              aria-current={p === page ? "page" : undefined}
              aria-label={`Go to page ${p} of ${label}`}
              key={p}
              onClick={() => onPageChange(p)}
              size="icon-sm"
              type="button"
              variant={p === page ? "default" : "ghost"}
            >
              {p}
            </Button>
          ))
        ) : (
          <span className="px-1 text-xs tabular-nums text-muted-foreground">
            {page} / {totalPages}
          </span>
        )}
        <Button
          aria-label={`Next page of ${label}`}
          disabled={page >= totalPages}
          onClick={() => onPageChange(clampPage(page + 1, totalPages))}
          size="icon-sm"
          type="button"
          variant="outline"
        >
          <CaretRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

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

/** "in 3m 12s" style relative time from a server-anchored clock. */
function formatInRelative(from: Date | null, iso: string | null): string {
  if (!iso) return "—";
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return "—";
  const now = from ? from.getTime() : Date.now();
  const diffMs = target - now;
  if (diffMs <= 0) return "due now";
  const totalSec = Math.floor(diffMs / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  if (m > 0) return `in ${m}m ${s}s`;
  return `in ${s}s`;
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
          className="gap-1 border-warning/30 bg-warning/10 text-warning"
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

/** Form state for the create/edit dialog. */
type ScheduleForm = {
  name: string;
  schedule: string;
  jobType: string;
  description: string;
  enabled: boolean;
};

const EMPTY_FORM: ScheduleForm = {
  name: "",
  schedule: "",
  jobType: "",
  description: "",
  enabled: true,
};

/**
 * Client-side validation for the dialog form. Mirrors the server rules
 * (node-cron 5-field expression). Returns per-field error strings.
 */
function validateForm(
  form: ScheduleForm,
  jobTypes: SchedulableJobType[]
): Partial<Record<keyof ScheduleForm, string>> {
  const errors: Partial<Record<keyof ScheduleForm, string>> = {};
  if (form.name.trim().length === 0) {
    errors.name = "Name is required";
  } else if (form.name.length > 128) {
    errors.name = "Name must be at most 128 characters";
  }
  if (form.schedule.trim().length === 0) {
    errors.schedule = "Cron expression is required";
  } else {
    const fields = form.schedule.trim().split(/\s+/);
    // Server (node-cron) accepts 5 or 6 fields; 6th = seconds.
    if (fields.length < 5 || fields.length > 6) {
      errors.schedule =
        "Expression must have 5 fields (min hour dom mon dow), or 6 with seconds";
    } else {
      // Accept everything the server's node-cron validate() accepts:
      // digits, ranges, steps, lists, and day/month names (mon, jan, sun…).
      const field = /^(\*|\d+|\d+-\d+|\*\/\d+|\d+\/\d+|[a-z]{3})(,[\d*a-z\/-]+)*$/i;
      if (!fields.every((f) => field.test(f))) {
        errors.schedule =
          "Invalid field(s). Examples: */15 * * * *, 0 9 * * mon, 30 8 1 jan *";
      }
    }
  }
  if (!jobTypes.some((t) => t.jobType === form.jobType)) {
    errors.jobType = "Select a job type";
  }
  if (form.description.length > 500) {
    errors.description = "Description must be at most 500 characters";
  }
  return errors;
}

export function CronJobsView({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<CronApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);
  const [feedbackNote, setFeedbackNote] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState(false);

  // Create / edit dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ScheduleForm>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<
    Partial<Record<keyof ScheduleForm, string>>
  >({});
  const [saving, setSaving] = useState(false);

  // Delete confirmation state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CronScheduleEntry | null>(
    null
  );

  // Pagination state — schedules are paginated client-side (small list),
  // executions are paginated server-side (job queue can be large).
  const [schedulePage, setSchedulePage] = useState(1);
  const [jobsPage, setJobsPage] = useState(1);

  // Live clock: server time from /api/health, ticked locally between
  // polls. Keeps next-run countdowns trustworthy against clock skew.
  const [serverNow, setServerNow] = useState<Date | null>(null);
  useEffect(() => {
    let cancelled = false;
    let anchorServer = 0;
    let anchorLocal = 0;

    const sync = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const json = (await res.json()) as { serverTime?: { now?: string } };
        if (!cancelled && json.serverTime?.now) {
          anchorServer = new Date(json.serverTime.now).getTime();
          anchorLocal = Date.now();
          // Advance the anchor by the request's elapsed time so the
          // displayed clock never jumps backward at a resync: the raw
          // server stamp predates the response by the full round-trip.
          setServerNow(new Date(anchorServer + (Date.now() - anchorLocal)));
        }
      } catch {
        // Health endpoint failure leaves the last known time ticking.
      }
    };

    const tick = () => {
      if (anchorServer > 0) {
        setServerNow(new Date(anchorServer + (Date.now() - anchorLocal)));
      }
    };

    void sync();
    const syncTimer = setInterval(() => void sync(), 30_000);
    const tickTimer = setInterval(tick, 1000);

    return () => {
      cancelled = true;
      clearInterval(syncTimer);
      clearInterval(tickTimer);
    };
  }, []);

  // Keep the latest schedule list for "run now" lookups after refetches.
  const schedulesRef = useRef<CronScheduleEntry[]>([]);
  schedulesRef.current = data?.schedules ?? [];

  const fetchCronData = useCallback(async (page: number) => {
    try {
      const res = await fetch(`/api/cron?page=${page}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as CronApiResponse;
      setData(json);
      // Clamp the executions page when the total shrinks (e.g. after the
      // hourly retention purge removes rows).
      if (json.jobsPagination && page > json.jobsPagination.totalPages) {
        setJobsPage(json.jobsPagination.totalPages);
      }
    } catch (err) {
      console.warn("Failed to fetch cron status", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchCronData(jobsPage);

    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (!cancelled) {
        void fetchCronData(jobsPage);
      }
    }, 5000);

    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && !document.hidden && !cancelled) {
        void fetchCronData(jobsPage);
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
  }, [fetchCronData, jobsPage]);

  const showFeedback = (note: string, isError = false) => {
    setFeedbackNote(note);
    setFeedbackError(isError);
  };

  const handleRunNow = async (id: string) => {
    const entry = schedulesRef.current.find((s) => s.id === id);
    setTriggeringId(id);
    setFeedbackNote(null);
    try {
      const res = await fetch("/api/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduleId: id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = (await res.json()) as { success: boolean; jobId?: string };
      showFeedback(
        `Enqueued ${entry?.name ?? "schedule"} now (job ${result.jobId ?? ""})`
      );
      void fetchCronData(jobsPage);
    } catch (err) {
      showFeedback(
        `Failed to trigger job: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    } finally {
      setTriggeringId(null);
    }
  };

  const openCreateDialog = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormErrors({});
    setDialogOpen(true);
  };

  const openEditDialog = (entry: CronScheduleEntry) => {
    setEditingId(entry.id);
    setForm({
      name: entry.name,
      schedule: entry.schedule,
      jobType: entry.jobType,
      description: entry.description,
      enabled: entry.enabled,
    });
    setFormErrors({});
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const jobTypes = data?.schedulableJobTypes ?? [];
    const errors = validateForm(form, jobTypes);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    try {
      const body = editingId
        ? {
            id: editingId,
            name: form.name.trim(),
            schedule: form.schedule.trim(),
            jobType: form.jobType,
            description: form.description.trim(),
            enabled: form.enabled,
          }
        : {
            name: form.name.trim(),
            schedule: form.schedule.trim(),
            jobType: form.jobType,
            description: form.description.trim(),
            enabled: form.enabled,
          };

      const res = await fetch("/api/cron/schedules", {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setDialogOpen(false);
      showFeedback(
        editingId
          ? `Schedule "${form.name.trim()}" updated`
          : `Schedule "${form.name.trim()}" created`
      );
      await fetchCronData(jobsPage);
    } catch (err) {
      setFormErrors({
        schedule: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (entry: CronScheduleEntry) => {
    setFeedbackNote(null);
    try {
      const res = await fetch("/api/cron/schedules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id, enabled: !entry.enabled }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      showFeedback(
        `Schedule "${entry.name}" ${entry.enabled ? "disabled" : "enabled"}`
      );
      await fetchCronData(jobsPage);
    } catch (err) {
      showFeedback(
        `Failed to toggle: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    }
  };

  const handleDelete = async (entry: CronScheduleEntry) => {
    setDeletingId(entry.id);
    setFeedbackNote(null);
    try {
      const res = await fetch(
        `/api/cron/schedules?id=${encodeURIComponent(entry.id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      setConfirmDelete(null);
      showFeedback(`Schedule "${entry.name}" deleted`);
      await fetchCronData(jobsPage);
    } catch (err) {
      showFeedback(
        `Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    } finally {
      setDeletingId(null);
    }
  };

  const jobTypeLabel = useMemo(() => {
    const map = new Map<string, SchedulableJobType>();
    for (const t of data?.schedulableJobTypes ?? []) map.set(t.jobType, t);
    return (jobType: string) => map.get(jobType)?.label ?? jobType;
  }, [data?.schedulableJobTypes]);

  return (
    <PageView
      actions={
        <>
          {serverNow && (
            <span
              className="hidden items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs tabular-nums text-muted-foreground sm:flex"
              data-testid="server-clock"
              title="Server clock (synchronized via /api/health)"
            >
              <Clock className="size-3.5 text-primary" />
              {serverNow.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
          )}
          <Button
            className="gap-1.5"
            disabled={loading}
            onClick={() => void fetchCronData(jobsPage)}
            size="sm"
            type="button"
            variant="outline"
          >
            <ArrowsClockwise
              className={loading ? "size-3.5 animate-spin" : "size-3.5"}
            />
            Refresh
          </Button>
          <Button
            className="gap-1.5"
            onClick={openCreateDialog}
            size="sm"
            type="button"
          >
            <Plus className="size-3.5" />
            Add Schedule
          </Button>
        </>
      }
      description="Configure the autonomous maintenance schedules — add, edit, disable or remove any cron job."
      onBack={onBack}
      title="Cron Jobs & Scheduled Tasks"
    >

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
                    data?.daemonRunning
                      ? "bg-green-500 animate-pulse"
                      : "bg-muted-foreground"
                  }`}
                />
                <span className="text-sm font-semibold">
                  {data?.daemonRunning
                    ? "Active & Running"
                    : "Stopped / Inactive"}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                Job Queue Runner
              </CardTitle>
              <CardDescription className="text-xs">
                Sequential background worker with GPU protection
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <span
                  className={`size-2.5 rounded-full ${
                    data?.queueRunnerRunning
                      ? "bg-green-500 animate-pulse"
                      : "bg-muted-foreground"
                  }`}
                />
                <span className="text-sm font-semibold">
                  {data?.queueRunnerRunning
                    ? "Active & Processing"
                    : "Stopped / Inactive"}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        {feedbackNote && (
          <div
            className={`mb-6 flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
              feedbackError
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-primary/30 bg-muted/40 text-foreground"
            }`}
          >
            <WarningCircle
              className={`size-4 shrink-0 ${feedbackError ? "text-destructive" : "text-primary"}`}
            />
            <span>{feedbackNote}</span>
          </div>
        )}

        {/* Configured Cron Schedules (user-managed, paginated client-side) */}
        <div className="mb-8 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Configured Schedules ({data?.schedules.length ?? 0})
          </h2>
          <div className="grid gap-3">
            {(data?.schedules.length ?? 0) === 0 ? (
              <Card>
                <CardContent className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No schedules configured. Use “Add Schedule” to create your
                  first cron job.
                </CardContent>
              </Card>
            ) : (
              data?.schedules
                .slice(
                  (schedulePage - 1) * SCHEDULES_PAGE_SIZE,
                  schedulePage * SCHEDULES_PAGE_SIZE
                )
                .map((entry) => (
                <Card
                  className={entry.enabled ? undefined : "opacity-70"}
                  key={entry.id}
                >
                  <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">{entry.name}</span>
                        {entry.builtIn ? (
                          <Badge variant="outline">built-in</Badge>
                        ) : null}
                        <Badge
                          className={
                            entry.enabled
                              ? "gap-1 border-green-600/30 bg-green-500/10 text-green-700 dark:text-green-400"
                              : undefined
                          }
                          variant="outline"
                        >
                          {entry.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                          {entry.schedule}
                        </code>
                        <span className="text-muted-foreground">
                          → {jobTypeLabel(entry.jobType)}
                        </span>
                      </div>
                      {entry.description ? (
                        <p className="text-xs text-muted-foreground">
                          {entry.description}
                        </p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        Next run:{" "}
                        <span className="font-medium">
                          {entry.enabled
                            ? `${formatIsoLocal(entry.nextRunAt)} (${formatInRelative(serverNow, entry.nextRunAt)})`
                            : "— (disabled)"}
                        </span>
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Switch
                        aria-label={`Toggle ${entry.name}`}
                        checked={entry.enabled}
                        onCheckedChange={() => void handleToggleEnabled(entry)}
                      />
                      <Button
                        className="gap-1.5"
                        disabled={triggeringId === entry.id}
                        onClick={() => void handleRunNow(entry.id)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <Play className="size-3.5" />
                        {triggeringId === entry.id ? "Running…" : "Run now"}
                      </Button>
                      <Button
                        aria-label={`Edit ${entry.name}`}
                        onClick={() => openEditDialog(entry)}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <PencilSimple className="size-4" />
                      </Button>
                      <Button
                        aria-label={`Delete ${entry.name}`}
                        onClick={() => setConfirmDelete(entry)}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <TrashSimple className="size-4 text-destructive" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
                ))
              )}
          </div>
          <Pager
            itemCount={data?.schedules.length}
            label="schedules"
            onPageChange={setSchedulePage}
            page={schedulePage}
            totalPages={
              Math.max(1, Math.ceil((data?.schedules.length ?? 0) / SCHEDULES_PAGE_SIZE))
            }
          />
        </div>

        {/* Create / edit dialog */}
        <Dialog
          onOpenChange={(open) => {
            if (!open) setDialogOpen(false);
            else setDialogOpen(true);
          }}
          open={dialogOpen}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {editingId ? "Edit Schedule" : "Add Schedule"}
              </DialogTitle>
              <DialogDescription>
                Schedules map a cron expression to a maintenance job type.
                Changes apply live — the daemon re-arms without a restart.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="cron-name">
                  Name
                </label>
                <Input
                  id="cron-name"
                  onChange={(e) =>
                    setForm((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder="Nightly memory tidy-up"
                  value={form.name}
                />
                {formErrors.name ? (
                  <p className="text-xs text-destructive">{formErrors.name}</p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="cron-expr">
                  Cron expression
                </label>
                <Input
                  className="font-mono"
                  id="cron-expr"
                  onChange={(e) =>
                    setForm((f) => ({ ...f, schedule: e.target.value }))
                  }
                  placeholder="*/15 * * * *"
                  value={form.schedule}
                />
                {formErrors.schedule ? (
                  <p className="text-xs text-destructive">
                    {formErrors.schedule}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    5 fields: minute hour day-of-month month day-of-week
                    (server-local timezone)
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium">Job type</label>
                <Select
                  onValueChange={(value) =>
                    setForm((f) => ({ ...f, jobType: value }))
                  }
                  value={form.jobType}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a job type…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(data?.schedulableJobTypes ?? []).map((t) => (
                      <SelectItem key={t.jobType} value={t.jobType}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {formErrors.jobType ? (
                  <p className="text-xs text-destructive">
                    {formErrors.jobType}
                  </p>
                ) : null}
                {form.jobType ? (
                  <p className="text-xs text-muted-foreground">
                    {data?.schedulableJobTypes.find(
                      (t) => t.jobType === form.jobType
                    )?.description ?? ""}
                  </p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="cron-desc">
                  Description (optional)
                </label>
                <Textarea
                  id="cron-desc"
                  onChange={(e) =>
                    setForm((f) => ({ ...f, description: e.target.value }))
                  }
                  placeholder="What this schedule does…"
                  rows={2}
                  value={form.description}
                />
                {formErrors.description ? (
                  <p className="text-xs text-destructive">
                    {formErrors.description}
                  </p>
                ) : null}
              </div>

              <div className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <p className="text-sm font-medium">Enabled</p>
                  <p className="text-xs text-muted-foreground">
                    Disabled schedules are stored but not armed by the daemon.
                  </p>
                </div>
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(checked) =>
                    setForm((f) => ({ ...f, enabled: checked }))
                  }
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                onClick={() => setDialogOpen(false)}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={saving}
                onClick={() => void handleSave()}
                type="button"
              >
                {saving
                  ? "Saving…"
                  : editingId
                    ? "Save changes"
                    : "Create schedule"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete confirmation dialog */}
        <Dialog
          onOpenChange={(open) => {
            if (!open) setConfirmDelete(null);
          }}
          open={confirmDelete !== null}
        >
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Delete schedule</DialogTitle>
              <DialogDescription>
                Remove “{confirmDelete?.name}”? Its armed cron task is stopped
                immediately; already-enqueued jobs still run to completion.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                onClick={() => setConfirmDelete(null)}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={deletingId !== null}
                onClick={() => {
                  if (confirmDelete) void handleDelete(confirmDelete);
                }}
                type="button"
                variant="destructive"
              >
                {deletingId ? "Deleting…" : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Recent Job Queue Executions (server-side paginated) */}
        <div className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Recent Executions ({data?.jobsPagination?.total ?? 0})
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
                        <td className="px-3 py-2 font-mono text-xs">
                          {job.id}
                        </td>
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
          <Pager
            itemCount={data?.jobsPagination?.total}
            label="executions"
            onPageChange={setJobsPage}
            page={data?.jobsPagination?.page ?? 1}
            totalPages={data?.jobsPagination?.totalPages ?? 1}
          />
          {data?.jobsPagination ? (
            <p className="text-xs text-muted-foreground">
              Showing{" "}
              {data.recentJobs.length > 0
                ? `${(data.jobsPagination.page - 1) * data.jobsPagination.pageSize + 1}–${(data.jobsPagination.page - 1) * data.jobsPagination.pageSize + data.recentJobs.length}`
                : "0"}{" "}
              of {data.jobsPagination.total} executions
            </p>
          ) : null}
        </div>
    </PageView>
  );
}
