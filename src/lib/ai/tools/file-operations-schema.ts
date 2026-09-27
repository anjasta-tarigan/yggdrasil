// src/lib/ai/tools/file-operations-schema.ts
//
// The single zod input schema for the `file_operations` tool, shared by the
// built-in chat tool and the project-harness fallback so both advertise an
// identical contract to the model. Kept separate from `file-operations-core.ts`
// so the durable workflow step (which imports the core) never pulls `zod`.

import { z } from "zod";
import { FILE_OPS_MAX_WRITE_BYTES } from "./file-operations-core";

export const fileOperationsInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    path: z.string().optional().describe("Directory path to list"),
    depth: z.number().min(1).max(5).optional().describe("Traversal depth"),
    showHidden: z.boolean().optional().describe("Include dotfiles"),
  }),
  z.object({
    action: z.literal("find"),
    pattern: z.string().describe("Filename or pattern to find"),
    path: z.string().optional().describe("Search root directory"),
  }),
  z.object({
    action: z.literal("grep"),
    query: z.string().describe("Text or regex to search inside files"),
    path: z.string().optional().describe("Search root directory or file"),
    caseSensitive: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("jump"),
    query: z.string().describe("Directory keyword to resolve"),
  }),
  z.object({
    action: z.literal("read"),
    path: z.string().describe("File path to read"),
    offset: z.number().optional().describe("Starting line number (1-based)"),
    limit: z.number().optional().describe("Line count limit"),
  }),
  z.object({
    action: z.literal("write"),
    path: z.string().describe("File path to write"),
    content: z.string().max(FILE_OPS_MAX_WRITE_BYTES).describe("File contents"),
    overwrite: z
      .boolean()
      .optional()
      .describe(
        "Set true to replace a file that already exists. Omit it: for an existing file use action 'edit' (surgical replacement) instead of rewriting the whole file."
      ),
  }),
  z.object({
    action: z.literal("edit"),
    path: z.string().describe("File path to edit"),
    oldString: z.string().describe("Exact substring to replace (must be unique)"),
    newString: z.string().describe("New replacement string"),
  }),
]);

export type FileOperationsInput = z.infer<typeof fileOperationsInputSchema>;
