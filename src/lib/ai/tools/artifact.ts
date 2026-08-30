import { tool } from "ai";
import { z } from "zod";

export const artifact_publish = tool({
  description:
    "Save and display a standalone deliverable in the dedicated side panel. You MUST call this tool whenever the user asks for a complete code file, script, HTML/CSS/JS demo, interactive app, game, SVG graphic, React component, full document/report, or multi-file project bundle, or mentions 'artifact'. NEVER output full standalone code files or interactive demos as markdown code blocks in your text reply; always call artifact_publish instead.",
  inputSchema: z.object({
    title: z
      .string()
      .min(1)
      .max(80)
      .describe(
        "Short human-readable title, e.g. 'Fibonacci Generator in Rust' or 'Interactive Calculator'"
      ),
    kind: z
      .enum(["code", "document", "project"])
      .describe(
        "'code' for programs, scripts, HTML/SVG/JSX; 'document' for markdown/prose reports; 'project' for multi-file bundle"
      ),
    language: z
      .string()
      .optional()
      .describe(
        "Programming language id for syntax highlighting (e.g., 'python', 'html', 'tsx', 'javascript', 'rust', 'svg'). Required when kind='code'"
      ),
    content: z
      .string()
      .optional()
      .describe("The complete artifact content without omissions or placeholders for single deliverables"),
    files: z
      .array(
        z.object({
          path: z.string().describe("Relative file path, e.g. 'src/App.tsx', 'README.md'"),
          content: z.string().describe("Full file content"),
          language: z.string().optional().describe("Syntax language id for this file"),
        })
      )
      .optional()
      .describe("Array of files for multi-file project or skill bundles"),
  }),
  execute: async ({ title, kind, language, content, files }) => ({
    title,
    kind,
    language,
    content,
    files,
  }),
});