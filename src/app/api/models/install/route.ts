import { NextResponse } from "next/server";
import { createHfClient } from "@/lib/models/hf-client";
import { planInstall, executeInstall } from "@/lib/models/installer";
import { getJobRegistry, JobConflictError } from "@/lib/models/jobs";
import type { ModelKind } from "@/lib/models/types";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const repo = body?.repo?.trim();
  const kind = (body?.kind ?? "embedding") as ModelKind;

  if (!repo) {
    return NextResponse.json({ error: "Missing 'repo' in body" }, { status: 400 });
  }

  try {
    const client = createHfClient();
    const plan = await planInstall({ repo, kind, client });
    const registry = getJobRegistry();

    let job;
    try {
      job = registry.createJob(kind, repo, plan.chosenVariant, plan.totalBytes);
    } catch (err) {
      if (err instanceof JobConflictError) {
        return NextResponse.json(
          { error: err.message, activeJobId: err.activeJobId },
          { status: 409 },
        );
      }
      throw err;
    }

    // Launch background execution
    void executeInstall(job, plan, client).catch((err) => {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
    });

    return NextResponse.json({ jobId: job.id, status: job.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
