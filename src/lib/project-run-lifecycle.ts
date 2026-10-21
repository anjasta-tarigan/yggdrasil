export interface ProjectRunReference {
  activeRunId?: string | null;
}

/** Stop live durable work before deleting the project/session it writes into. */
export async function cancelProjectRuns(sessions: ProjectRunReference[]): Promise<void> {
  const runIds = [...new Set(sessions.flatMap((session) => session.activeRunId ? [session.activeRunId] : []))];
  if (runIds.length === 0) return;

  const { getRun } = await import("workflow/api");
  for (const runId of runIds) {
    const run = getRun(runId);
    if (!(await run.exists)) continue;
    const status = await run.status;
    if (status === "pending" || status === "running") {
      await run.cancel({ cancelReason: "Owning project or session was deleted" });
    }
  }
}
