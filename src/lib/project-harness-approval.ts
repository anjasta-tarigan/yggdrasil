// Node:fs-free module: this holds the approval predicates that BOTH the durable
// workflow and the fallback route use. It must not import project-harness-tools
// (which pulls node:fs), because the workflow function's bundle forbids Node.js
// modules. The predicates delegate to the shared tool-policy engine.

import { evaluateToolApproval } from "@/lib/ai/tool-policy";
import type { FileOperationsInput } from "@/lib/project-harness-tools";

/**
 * Approval predicate for the bash tool, delegating to the shared policy so the
 * durable path cannot drift from the fallback path.
 */
export const bashToolNeedsApproval = (input: { command?: string; cmd?: string }) =>
  evaluateToolApproval("bash", input).then((v) => v === "user-approval");

/**
 * Approval predicate for the file_operations tool. Destructive actions (write,
 * edit) are already gated by directory trust; this delegates to the shared policy
 * so any future rule (e.g. a destructive action verb) applies uniformly.
 */
export const fileOperationsNeedsApproval = (input: FileOperationsInput) =>
  evaluateToolApproval("file_operations", input).then((v) => v === "user-approval");
