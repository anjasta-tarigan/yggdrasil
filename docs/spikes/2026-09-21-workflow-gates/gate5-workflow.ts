/**
 * SPIKE gate 5 — can a step drain its own run's stream?
 * §4.4(b) claims it deadlocks. This measures it.
 */
import { getWritable, getWorkflowMetadata } from "workflow";
import { getRun } from "workflow/api";

async function writeChunk(text: string) {
  "use step";
  const w = getWritable<string>();
  const writer = w.getWriter();
  await writer.write(text);
  writer.releaseLock();
}

async function tryReadOwnStream(budgetMs: number) {
  "use step";
  const { workflowRunId } = getWorkflowMetadata();
  const run = getRun(workflowRunId);
  const readable = run.getReadable({ startIndex: 0 });
  const reader = readable.getReader();
  const chunks: string[] = [];

  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), budgetMs);
  });

  const drain = (async (): Promise<"done"> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(String(value));
      }
      return "done";
    } catch {
      return "done";
    }
  })();

  const outcome = await Promise.race([drain, timeout]);
  try {
    await reader.cancel();
  } catch {
    /* already closed */
  }
  return { outcome, timedOut: outcome === "timeout", chunkCount: chunks.length, chunks };
}

export async function readBackWorkflow() {
  "use workflow";
  await writeChunk("alpha");
  await writeChunk("beta");
  return await tryReadOwnStream(3000);
}
