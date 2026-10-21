import { assertSafeCommand } from "@/lib/sandbox/host-sandbox";
import { executeFileOperations } from "@/lib/ai/tools/file-operations-core";
import { executeBashCommand } from "@/lib/project-harness-tools";

/**
 * Durable step implementations for the Projects harness tools.
 *
 * These live in the step bundle (full Node.js access), so they may use
 * `node:fs`/`node:child_process` directly. They are intentionally self-contained
 * with respect to `project-harness-tools.ts`: that module transitively pulls
 * `web`/`task`/`artifact` (→ `ssrf`/`db`/`log-store`), which the Workflow
 * runtime forbids in the workflow-function bundle. The file-operations
 * behaviour is shared via `file-operations-core.ts`, which imports only node
 * builtins plus the leaf `file-security`/`file-capabilities` modules and is
 * therefore safe to pull into the step bundle.
 *
 * Each step receives configuration via the per-tool `toolsContext` entry
 * (`{ canonicalRoot, trusted, ... }`), never from a closure, because a step
 * receives parameters, not the workflow's live scope (spec §3.4). Mutating steps
 * are wired with `maxRetries: 0` by the workflow so a half-applied change is
 * reported rather than silently re-run (spec §3.6.4).
 */

/**
 * Durable bash step. Runs the command via `bash -c` in the canonical root.
 */
export async function projectBashStep(
  input: { command?: string; cmd?: string },
  options: {
    context?: { canonicalRoot: string; trusted: boolean; timeoutMs?: number; maxOutputChars?: number };
    abortSignal?: AbortSignal;
  }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  "use step";
  const ctx = options.context ?? {
    canonicalRoot: "",
    trusted: false,
    timeoutMs: 60_000,
    maxOutputChars: 30_000,
  };
  const rawCmd = (input.command ?? input.cmd ?? "").trim();
  if (!rawCmd) return { stdout: "", stderr: "No command provided", exitCode: 1 };
  if (!ctx.trusted) {
    return {
      stdout: "",
      stderr:
        "Directory trust required to execute shell commands. Please approve directory trust in the project view before running terminal commands.",
      exitCode: 126,
    };
  }
  try {
    assertSafeCommand(rawCmd);
  } catch (err) {
    return { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 126 };
  }
  return executeBashCommand(
    rawCmd,
    ctx.canonicalRoot,
    ctx.timeoutMs,
    options.abortSignal,
    ctx.maxOutputChars
  );
}

/**
 * Durable file_operations step. Delegates to the shared implementation
 * (`file-operations-core.ts`) so the durable path, the fallback tool and the
 * built-in chat tool cannot drift apart. The project harness permits larger
 * writes (5 MB) than the chat tool, so the cap is passed explicitly.
 */
export async function projectFileOpsStep(
  input: {
    action: string;
    path?: string;
    depth?: number;
    showHidden?: boolean;
    pattern?: string;
    query?: string;
    caseSensitive?: boolean;
    offset?: number;
    limit?: number;
    content?: string;
    overwrite?: boolean;
    oldString?: string;
    newString?: string;
  },
  options: {
    context?: { canonicalRoot: string; trusted: boolean; maxOutputBytes?: number };
  }
): Promise<Record<string, unknown>> {
  "use step";
  const ctx = options.context ?? {
    canonicalRoot: "",
    trusted: false,
    maxOutputBytes: 50 * 1024,
  };

  // Cast to the step's loose return type: the durable workflow serializes the
  // result across the step boundary as plain JSON, so the precise shape is not
  // needed on this side.
  return (await executeFileOperations(input, {
    canonicalRoot: ctx.canonicalRoot,
    trusted: ctx.trusted,
    maxOutputBytes: ctx.maxOutputBytes,
    maxWriteBytes: 5 * 1024 * 1024,
  })) as Record<string, unknown>;
}

/**
 * Durable step for the web_search tool. Search performs network I/O across
 * providers (Exa/Firecrawl/SearXNG), which the workflow function cannot do; the
 * step bundle can. `runWebSearch` is imported here (not in the workflow) so its
 * `settings-service`/env imports stay out of the workflow-function bundle.
 */
export async function projectWebSearchStep(
  input: { query: string; numResults?: number; includeText?: boolean }
): Promise<unknown> {
  "use step";
  // `frameSearchOutcome` lives in the same module as the tool so the durable
  // path frames results identically to the chat path.
  const { runWebSearch } = await import("@/lib/web-search");
  const { frameSearchOutcome } = await import("@/lib/ai/tools/web");
  const outcome = await runWebSearch(input.query, {
    numResults: input.numResults ?? 5,
    includeText: input.includeText ?? false,
  });
  return frameSearchOutcome(outcome);
}

/**
 * Durable step for the create_artifact tool. The tool is a pure echo (it returns
 * its input for the client to render), so the step just normalizes the payload.
 */
export async function projectArtifactStep(input: {
  title: string;
  kind: "code" | "document" | "project";
  language?: string;
  content?: string;
  files?: Array<{ path: string; content: string; language?: string }>;
}): Promise<unknown> {
  "use step";
  return {
    title: input.title,
    kind: input.kind,
    language: input.language,
    content: input.content,
    files: input.files,
  };
}

/**
 * Durable step for the manage_tasks tool. Pure computation over the task list.
 */
export async function projectTasksStep(input: {
  title: string;
  items: Array<{ text: string; status: "pending" | "in_progress" | "completed" }>;
}): Promise<unknown> {
  "use step";
  const completed = input.items.filter((i) => i.status === "completed").length;
  return {
    title: input.title,
    items: input.items,
    completed,
    total: input.items.length,
    done: completed === input.items.length,
  };
}

/**
 * Durable step for the web_fetch tool. Fetching performs network I/O (Firecrawl
 * API or native HTTP + HTML→Markdown), which the workflow function cannot do.
 * `fetchWebPage` is imported here (not in the workflow) so its `ssrf`/`node:dns`
 * imports stay out of the workflow-function bundle.
 */
export async function projectWebFetchStep(input: {
  url: string;
  maxCharacters?: number;
}): Promise<unknown> {
  "use step";
  const { fetchWebPage, frameFetchedPage } = await import("@/lib/ai/tools/web");
  const max = Math.min(20000, Math.max(200, input.maxCharacters ?? 8000));
  return frameFetchedPage(await fetchWebPage(input.url, max));
}
