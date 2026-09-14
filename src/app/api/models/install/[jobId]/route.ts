import { NextResponse } from "next/server";
import { getJobRegistry } from "@/lib/models/jobs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = getJobRegistry().getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: job.id,
    status: job.status,
    bytesDownloaded: job.bytesDownloaded,
    estimatedBytes: job.estimatedBytes,
    currentFile: job.currentFile,
    error: job.error,
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = getJobRegistry().getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  job.abortController.abort();
  job.status = "aborted";
  return NextResponse.json({ success: true });
}
