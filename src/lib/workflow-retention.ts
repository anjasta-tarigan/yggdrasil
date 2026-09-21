/** Completed workflow runs older than this are pruned from data/workflow. */
export const WORKFLOW_RETENTION_DAYS = 30;

export interface WorkflowRunRecord {
  runId: string;
  /** ISO-8601 timestamp of when the run was created. */
  createdAt: string;
}

/**
 * Selects runs eligible for pruning.
 *
 * Pure so the policy is testable without touching the filesystem. A run is
 * pruned only once it is strictly older than the window: a boundary run is
 * kept, because pruning it early loses data a user might still resume from.
 *
 * Note for the caller: pruning a run whose id is still recorded in
 * `project_sessions.active_run_id` is safe *because* the claim path treats a
 * not-found run as stale (spec §4.5). Do not change one without the other.
 */
export function runsToPrune(runs: WorkflowRunRecord[], now: Date): string[] {
  const cutoff =
    now.getTime() - WORKFLOW_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return runs
    .filter((run) => new Date(run.createdAt).getTime() < cutoff)
    .map((run) => run.runId);
}
