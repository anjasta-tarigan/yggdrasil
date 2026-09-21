import { describe, it, expect } from "vitest";
import { runsToPrune, WORKFLOW_RETENTION_DAYS } from "@/lib/workflow-retention";

const now = new Date("2026-09-21T00:00:00Z");
const daysAgo = (n: number) =>
  new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe("runsToPrune", () => {
  it("keeps runs inside the retention window", () => {
    const runs = [{ runId: "a", createdAt: daysAgo(1) }];
    expect(runsToPrune(runs, now)).toEqual([]);
  });

  it("prunes runs older than the window", () => {
    const runs = [{ runId: "b", createdAt: daysAgo(WORKFLOW_RETENTION_DAYS + 1) }];
    expect(runsToPrune(runs, now)).toEqual(["b"]);
  });

  it("keeps a run exactly at the boundary", () => {
    const runs = [{ runId: "c", createdAt: daysAgo(WORKFLOW_RETENTION_DAYS) }];
    expect(runsToPrune(runs, now)).toEqual([]);
  });
});
