import { describe, it, expect } from "vitest";
import { repairToolCallByName } from "@/lib/ai/tool-name-repair";

const AVAILABLE = ["bash", "file_operations", "manage_tasks", "create_artifact", "web_search", "web_fetch"];

function call(toolName: string, input: object): Parameters<typeof repairToolCallByName>[0] {
  return { type: "tool-call" as const, toolCallId: "tc1", toolName, input: JSON.stringify(input) };
}

describe("repairToolCallByName", () => {
  // ── file alias → file_operations ───────────────────────────────────────
  it("maps 'read' to file_operations(action=read)", () => {
    const result = repairToolCallByName(call("read", { path: "foo.ts" }), AVAILABLE);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("file_operations");
    const input = JSON.parse(result!.input) as Record<string, unknown>;
    expect(input.action).toBe("read");
    expect(input.path).toBe("foo.ts");
  });

  it("maps 'read_file' to file_operations(action=read)", () => {
    const result = repairToolCallByName(call("read_file", { path: "x.ts" }), AVAILABLE);
    expect(result?.toolName).toBe("file_operations");
    expect(JSON.parse(result!.input).action).toBe("read");
  });

  it("maps 'cat' to file_operations(action=read)", () => {
    expect(JSON.parse(repairToolCallByName(call("cat", { path: "a" }), AVAILABLE)!.input).action).toBe("read");
  });

  it("maps 'view' to file_operations(action=read)", () => {
    expect(JSON.parse(repairToolCallByName(call("view", { path: "a" }), AVAILABLE)!.input).action).toBe("read");
  });

  it("maps 'write' to file_operations(action=write)", () => {
    const result = repairToolCallByName(call("write", { path: "out.ts", content: "x" }), AVAILABLE);
    expect(result!.toolName).toBe("file_operations");
    const input = JSON.parse(result!.input) as Record<string, unknown>;
    expect(input.action).toBe("write");
    expect(input.content).toBe("x");
  });

  it("maps 'write_file' to file_operations(action=write)", () => {
    expect(JSON.parse(repairToolCallByName(call("write_file", { path: "x", content: "" }), AVAILABLE)!.input).action).toBe("write");
  });

  it("maps 'create_file' to file_operations(action=write)", () => {
    expect(JSON.parse(repairToolCallByName(call("create_file", { path: "x", content: "" }), AVAILABLE)!.input).action).toBe("write");
  });

  it("maps 'edit' to file_operations(action=edit)", () => {
    const r = repairToolCallByName(call("edit", { path: "f", oldString: "a", newString: "b" }), AVAILABLE);
    expect(JSON.parse(r!.input).action).toBe("edit");
  });

  it("maps 'str_replace' to file_operations(action=edit)", () => {
    expect(JSON.parse(repairToolCallByName(call("str_replace", { path: "f", oldString: "a", newString: "b" }), AVAILABLE)!.input).action).toBe("edit");
  });

  it("maps 'replace' to file_operations(action=edit)", () => {
    expect(JSON.parse(repairToolCallByName(call("replace", { path: "f", oldString: "x", newString: "y" }), AVAILABLE)!.input).action).toBe("edit");
  });

  it("maps 'edit_file' to file_operations(action=edit)", () => {
    expect(JSON.parse(repairToolCallByName(call("edit_file", { path: "f", oldString: "x", newString: "y" }), AVAILABLE)!.input).action).toBe("edit");
  });

  it("maps 'patch' to file_operations(action=edit)", () => {
    expect(JSON.parse(repairToolCallByName(call("patch", { path: "f", oldString: "x", newString: "y" }), AVAILABLE)!.input).action).toBe("edit");
  });

  it("maps 'ls' to file_operations(action=list)", () => {
    expect(JSON.parse(repairToolCallByName(call("ls", { path: "." }), AVAILABLE)!.input).action).toBe("list");
  });

  it("maps 'list' to file_operations(action=list)", () => {
    expect(JSON.parse(repairToolCallByName(call("list", { path: "." }), AVAILABLE)!.input).action).toBe("list");
  });

  it("maps 'list_dir' to file_operations(action=list)", () => {
    expect(JSON.parse(repairToolCallByName(call("list_dir", {}), AVAILABLE)!.input).action).toBe("list");
  });

  it("maps 'list_files' to file_operations(action=list)", () => {
    expect(JSON.parse(repairToolCallByName(call("list_files", {}), AVAILABLE)!.input).action).toBe("list");
  });

  it("maps 'listdir' to file_operations(action=list)", () => {
    expect(JSON.parse(repairToolCallByName(call("listdir", {}), AVAILABLE)!.input).action).toBe("list");
  });

  it("maps 'grep' to file_operations(action=grep)", () => {
    expect(JSON.parse(repairToolCallByName(call("grep", { query: "foo" }), AVAILABLE)!.input).action).toBe("grep");
  });

  it("maps 'search' to file_operations(action=grep)", () => {
    expect(JSON.parse(repairToolCallByName(call("search", { query: "foo" }), AVAILABLE)!.input).action).toBe("grep");
  });

  it("maps 'search_files' to file_operations(action=grep)", () => {
    expect(JSON.parse(repairToolCallByName(call("search_files", { query: "x" }), AVAILABLE)!.input).action).toBe("grep");
  });

  it("maps 'find' to file_operations(action=find)", () => {
    expect(JSON.parse(repairToolCallByName(call("find", { pattern: "*.ts" }), AVAILABLE)!.input).action).toBe("find");
  });

  it("maps 'glob' to file_operations(action=find)", () => {
    expect(JSON.parse(repairToolCallByName(call("glob", { pattern: "*.ts" }), AVAILABLE)!.input).action).toBe("find");
  });

  it("maps 'find_files' to file_operations(action=find)", () => {
    expect(JSON.parse(repairToolCallByName(call("find_files", { pattern: "*.ts" }), AVAILABLE)!.input).action).toBe("find");
  });

  // ── shell alias → bash ─────────────────────────────────────────────────
  it("maps 'shell' to bash, keeping input unchanged", () => {
    const r = repairToolCallByName(call("shell", { command: "ls -la" }), AVAILABLE);
    expect(r!.toolName).toBe("bash");
    expect(JSON.parse(r!.input).command).toBe("ls -la");
  });

  it("maps 'run' to bash", () => {
    expect(repairToolCallByName(call("run", { command: "echo hi" }), AVAILABLE)!.toolName).toBe("bash");
  });

  it("maps 'run_command' to bash", () => {
    expect(repairToolCallByName(call("run_command", { command: "x" }), AVAILABLE)!.toolName).toBe("bash");
  });

  it("maps 'execute' to bash", () => {
    expect(repairToolCallByName(call("execute", { command: "x" }), AVAILABLE)!.toolName).toBe("bash");
  });

  it("maps 'terminal' to bash", () => {
    expect(repairToolCallByName(call("terminal", { command: "x" }), AVAILABLE)!.toolName).toBe("bash");
  });

  it("maps 'exec' to bash", () => {
    expect(repairToolCallByName(call("exec", { command: "x" }), AVAILABLE)!.toolName).toBe("bash");
  });

  // ── case and separator normalization ───────────────────────────────────
  it("normalizes uppercase: 'WRITE' maps to file_operations(action=write)", () => {
    const r = repairToolCallByName(call("WRITE", { path: "x", content: "" }), AVAILABLE);
    expect(r!.toolName).toBe("file_operations");
    expect(JSON.parse(r!.input).action).toBe("write");
  });

  it("normalizes dashes: 'write-file' maps to file_operations(action=write)", () => {
    const r = repairToolCallByName(call("write-file", { path: "x", content: "" }), AVAILABLE);
    expect(r!.toolName).toBe("file_operations");
    expect(JSON.parse(r!.input).action).toBe("write");
  });

  it("normalizes spaces: 'write file' maps to file_operations(action=write)", () => {
    const r = repairToolCallByName(call("write file", { path: "x", content: "" }), AVAILABLE);
    expect(r!.toolName).toBe("file_operations");
    expect(JSON.parse(r!.input).action).toBe("write");
  });

  // ── action preservation ────────────────────────────────────────────────
  it("preserves an already-present 'action' field (same as default)", () => {
    const r = repairToolCallByName(call("read_file", { path: "x.ts", action: "read" }), AVAILABLE);
    expect(JSON.parse(r!.input).action).toBe("read");
  });

  it("does not overwrite a model-supplied 'action' that differs from the alias default", () => {
    // Model called unknown tool "read_file" but already included action=write.
    // Per spec: never overwrite an action the model already supplied.
    const r = repairToolCallByName(
      call("read_file", { path: "x.ts", action: "write" }),
      AVAILABLE
    );
    expect(JSON.parse(r!.input).action).toBe("write");
  });

  // ── target tool must exist in available set ────────────────────────────
  it("returns null when file_operations is not available", () => {
    const withoutFileOps = AVAILABLE.filter((n) => n !== "file_operations");
    expect(repairToolCallByName(call("write", { path: "x", content: "" }), withoutFileOps)).toBeNull();
  });

  it("returns null when bash is not available", () => {
    const withoutBash = AVAILABLE.filter((n) => n !== "bash");
    expect(repairToolCallByName(call("shell", { command: "x" }), withoutBash)).toBeNull();
  });

  // ── invalid JSON input ─────────────────────────────────────────────────
  it("returns null when input is not valid JSON", () => {
    const badCall = { type: "tool-call" as const, toolCallId: "tc2", toolName: "write", input: "not json" };
    expect(repairToolCallByName(badCall, AVAILABLE)).toBeNull();
  });

  // ── non-object JSON input ──────────────────────────────────────────────
  it("returns null when input JSON is an array", () => {
    const arrCall = { type: "tool-call" as const, toolCallId: "tc3", toolName: "write", input: '["a","b"]' };
    expect(repairToolCallByName(arrCall, AVAILABLE)).toBeNull();
  });

  it("returns null when input JSON is a scalar string", () => {
    const scalarCall = { type: "tool-call" as const, toolCallId: "tc4", toolName: "write", input: '"just a string"' };
    expect(repairToolCallByName(scalarCall, AVAILABLE)).toBeNull();
  });

  it("returns null when input JSON is a number", () => {
    const numCall = { type: "tool-call" as const, toolCallId: "tc5", toolName: "write", input: "42" };
    expect(repairToolCallByName(numCall, AVAILABLE)).toBeNull();
  });

  // ── unknown tool name ──────────────────────────────────────────────────
  it("returns null for a completely unknown tool name ('foo')", () => {
    expect(repairToolCallByName(call("foo", {}), AVAILABLE)).toBeNull();
  });

  it("returns null for another unknown name ('get_context')", () => {
    expect(repairToolCallByName(call("get_context", {}), AVAILABLE)).toBeNull();
  });
});
