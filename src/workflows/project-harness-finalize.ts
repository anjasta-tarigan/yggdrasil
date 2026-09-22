import type { ModelMessage } from "ai";
import {
  saveProjectSession,
  releaseProjectRun,
  getProjectSession,
  type StoredProjectSession,
} from "@/lib/project-service";
import { modelMessagesToUIMessages } from "@/lib/ai/model-message-to-ui-message";

/**
 * Persists a finished durable harness turn and releases the session's run slot.
 *
 * Runs as a durable step (not in the workflow function) because it touches
 * `project-service`, which imports the SQLite `db` (node:fs). The workflow
 * function cannot do that. `finalizeHarnessRunStep` is routed to the step bundle,
 * where node:fs is allowed.
 *
 * It converts the agent's `ModelMessage[]` result back into `UIMessage[]` for
 * storage (the SDK ships no inverse of `convertToModelMessages`), then writes the
 * session and clears `activeRunId`. The slot release uses the exact runId so a
 * concurrently-claimed run is never clobbered (spec §4.5).
 */
export async function finalizeHarnessRunStep(input: {
  sessionId: string;
  runId: string;
  messages: ModelMessage[];
}): Promise<void> {
  "use step";
  const { sessionId, runId, messages } = input;
  const current = await getProjectSession(sessionId);
  if (!current) return;

  const uiMessages = modelMessagesToUIMessages(messages, {
    generateId: () => `pmsg_${Math.random().toString(36).slice(2)}`,
  });

  const next: StoredProjectSession = {
    ...current,
    messages: uiMessages,
    updatedAt: Date.now(),
  };
  await saveProjectSession(next);
  releaseProjectRun(sessionId, runId);
}

/**
 * Releases a session's durable-run slot without persisting. Used in a `finally`
 * so a run that fails mid-turn (e.g. a model/provider error) still clears its
 * `activeRunId` pointer — otherwise the session would keep a stale pointer until
 * the next POST reclaims it. Persisting is skipped because a failed turn has no
 * complete transcript to save.
 */
export async function releaseHarnessRunStep(input: {
  sessionId: string;
  runId: string;
}): Promise<void> {
  "use step";
  releaseProjectRun(input.sessionId, input.runId);
}
