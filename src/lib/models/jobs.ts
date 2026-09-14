/**
 * Install job registry — tracks in-flight model installs to prevent
 * conflicting concurrent downloads of the same repo and to reserve
 * disk bytes for each active job.
 *
 * Lives on `globalThis` so a forked child process (smoke worker) and the
 * server/share-process can share state within a single Node process.
 */

import { nanoid } from "nanoid";
import type { ModelKind } from "./types";
import { getModelDir } from "./store";

export class JobConflictError extends Error {
  constructor(readonly activeVariant: string, readonly activeJobId: string) {
    super(`Variant conflict: variant '${activeVariant}' is currently installing (job ${activeJobId}). Cancel it or wait.`);
    this.name = "JobConflictError";
  }
}

export interface InstallJob {
  id: string;
  kind: ModelKind;
  repo: string;
  variant: string;
  estimatedBytes: number;
  bytesDownloaded: number;
  currentFile?: string;
  status: "pending" | "downloading" | "smoke-testing" | "completed" | "failed" | "aborted";
  error?: string;
  abortController: AbortController;
  createdAt: string;
}

/** A job is "active" while it's still in progress (not completed/failed/aborted). */
function isActive(status: InstallJob["status"]): boolean {
  return status === "pending" || status === "downloading" || status === "smoke-testing";
}

const GLOBAL_JOBS_KEY = "__yggdrasilModelInstallJobs";

class JobRegistry {
  private get map(): Map<string, InstallJob> {
    const g = globalThis as unknown as Record<string, unknown>;
    if (!g[GLOBAL_JOBS_KEY]) {
      g[GLOBAL_JOBS_KEY] = new Map<string, InstallJob>();
    }
    return g[GLOBAL_JOBS_KEY] as Map<string, InstallJob>;
  }

  private key(kind: ModelKind, repo: string): string {
    return `${kind}:${repo}`;
  }

  getJob(id: string): InstallJob | undefined {
    for (const job of this.map.values()) {
      if (job.id === id) return job;
    }
    return undefined;
  }

  getActiveJob(kind: ModelKind, repo: string): InstallJob | undefined {
    const job = this.map.get(this.key(kind, repo));
    if (job && isActive(job.status)) {
      return job;
    }
    return undefined;
  }

  createJob(kind: ModelKind, repo: string, variant: string, estimatedBytes: number): InstallJob {
    const k = this.key(kind, repo);
    const active = this.getActiveJob(kind, repo);
    if (active) {
      if (active.variant !== variant) {
        throw new JobConflictError(active.variant, active.id);
      }
      return active;
    }

    const job: InstallJob = {
      id: nanoid(),
      kind,
      repo,
      variant,
      estimatedBytes,
      bytesDownloaded: 0,
      status: "pending",
      abortController: new AbortController(),
      createdAt: new Date().toISOString(),
    };
    this.map.set(k, job);
    return job;
  }

  getOrCreateJob(kind: ModelKind, repo: string, variant: string, estimatedBytes: number): InstallJob {
    const active = this.getActiveJob(kind, repo);
    if (active) {
      if (active.variant !== variant) {
        throw new JobConflictError(active.variant, active.id);
      }
      return active;
    }
    return this.createJob(kind, repo, variant, estimatedBytes);
  }

  getTotalBytesReserved(): number {
    let total = 0;
    for (const job of this.map.values()) {
      if (isActive(job.status)) {
        total += Math.max(0, job.estimatedBytes - job.bytesDownloaded);
      }
    }
    return total;
  }

  /**
   * Returns absolute directory paths for all active job model dirs.
   * Used by `store.sweepOrphans` to protect in-flight install dirs from purge.
   */
  getActiveJobDirs(customBase?: string): Set<string> {
    const dirs = new Set<string>();
    for (const job of this.map.values()) {
      if (isActive(job.status)) {
        dirs.add(getModelDir(job.kind, job.repo, customBase));
      }
    }
    return dirs;
  }

  clearAllForTest(): void {
    this.map.clear();
  }
}

const registry = new JobRegistry();
export function getJobRegistry(): JobRegistry {
  return registry;
}
