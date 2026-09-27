// src/lib/ai/tools/files.ts
import { tool } from "ai";
import path from "node:path";
import { executeFileOperations } from "./file-operations-core";
import { fileOperationsInputSchema } from "./file-operations-schema";

/**
 * Built-in filesystem tool for the CHAT agent.
 *
 * Scoped to a dedicated workspace directory (`<data>/workspace`), NOT the
 * Yggdrasil install tree and NOT the scratch sandbox (`data/sandbox`):
 *
 *  - The install tree is the application's own source/data; a chat model has
 *    no business reading or editing it, and `process.cwd()` points there in a
 *    production install (`~/.yggdrasil/app`).
 *  - The sandbox (`data/sandbox`) is a throwaway scratch area owned by the
 *    bash/readFile/writeFile tools.
 *  - `data/workspace` is the persistent place for user files the assistant is
 *    asked to work on in an ordinary chat.
 *
 * All path safety, sensitive-file blocking, output capping and CLI fallbacks
 * live in `file-operations-core.ts`, shared with the project harness so the
 * three historical copies cannot drift again.
 */

/**
 * Dedicated chat workspace root. Resolved at call time (not module load) so it
 * tracks the server's working directory the same way the sandbox root does,
 * and honors an explicit `YGGDRASIL_WORKSPACE_DIR` override.
 */
export function chatWorkspaceRoot(): string {
  const override = process.env.YGGDRASIL_WORKSPACE_DIR;
  return path.resolve(
    override || path.join(/* turbopackIgnore: true */ process.cwd(), "data", "workspace")
  );
}

export const file_operations = tool({
  description:
    "High-performance filesystem operations tool for the persistent chat workspace (a dedicated directory for user files, created on first use). Provides actions: 'list' (directory tree), 'find' (fast file search), 'grep' (text search), 'jump' (directory jumping), 'read' (view file with line numbers), 'write' (create/overwrite file, with a backup on explicit overwrite), and 'edit' (exact surgical find-and-replace). Enforces workspace containment, protects sensitive files, and uses modern CLI tools (eza, fd, rg) with automatic fallbacks. This is a DIFFERENT tree from the scratch sandbox used by bash/readFile/writeFile — use file_operations for persistent user files, and the sandbox tools for throwaway scratch work. Files are created relative to the workspace root.",
  inputSchema: fileOperationsInputSchema,
  execute: async (input) =>
    executeFileOperations(input, {
      canonicalRoot: chatWorkspaceRoot(),
      trusted: true,
      allowJump: true,
    }),
});
