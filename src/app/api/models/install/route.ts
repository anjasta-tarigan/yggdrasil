import { NextResponse } from "next/server";
import { z } from "zod";
import { createHfClient } from "@/lib/models/hf-client";
import { planInstall, executeInstall } from "@/lib/models/installer";
import { getJobRegistry, JobConflictError } from "@/lib/models/jobs";

const InstallSchema = z.object({
  repo: z.string().trim().min(1).max(256),
  kind: z.enum(["embedding", "reranker"]).default("embedding"),
  variant: z.string().trim().optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = InstallSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request payload", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { repo, kind, variant } = parsed.data;

  try {
    const client = createHfClient();
    const plan = await planInstall({ repo, kind, client, preferredVariant: variant });
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

    // Launch background execution with abort-awareness
    void executeInstall(job, plan, client).catch((err) => {
      if (job.abortController.signal.aborted || job.status === "aborted") {
        job.status = "aborted";
        job.error = undefined;
      } else {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
      }
    });

    return NextResponse.json({ jobId: job.id, status: job.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
