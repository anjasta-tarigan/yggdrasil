import { describe, it, expect } from "vitest";
import { evaluateToolApproval } from "../tool-policy";

describe("evaluateToolApproval Policy Engine", () => {
  describe("Destructive bash / projectBash commands requiring user-approval", () => {
    it("flags recursive deletions (rm -rf, rm -r)", async () => {
      expect(
        await evaluateToolApproval("bash", { command: "rm -rf /tmp/data" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("bash", { command: "rm -r ./dist" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("projectBash", { command: "rm -fr node_modules" })
      ).toBe("user-approval");
    });

    it("flags package manager installations", async () => {
      expect(
        await evaluateToolApproval("bash", { command: "npm install express" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("bash", { command: "npm i -D typescript" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("bash", { command: "pnpm add zod" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("bash", { command: "pnpm i axios" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("bash", { command: "yarn add lucide-react" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("bash", { command: "bun add drizzle-orm" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("bash", { command: "pip install torch" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("bash", { command: "pip3 install numpy" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("bash", { command: "cargo add serde" })
      ).toBe("user-approval");
    });

    it("flags process termination commands (kill, killall, pkill)", async () => {
      expect(
        await evaluateToolApproval("bash", { command: "kill -9 12345" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("bash", { command: "killall node" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("projectBash", { command: "pkill -f next-server" })
      ).toBe("user-approval");
    });

    it("flags dangerous git mutations (reset --hard, push --force, clean -f)", async () => {
      expect(
        await evaluateToolApproval("bash", { command: "git reset --hard HEAD~1" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("bash", { command: "git push --force origin main" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("bash", { command: "git push -f origin main" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("bash", { command: "git clean -fd" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("bash", { command: "git clean -f" })
      ).toBe("user-approval");
    });
  });

  describe("Dangerous MCP tools requiring user-approval", () => {
    it("flags tools starting with delete_, drop_, destroy_", async () => {
      expect(
        await evaluateToolApproval("server_delete_user", { id: "123" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("postgres_drop_table", { table: "users" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("cloud_destroy_instance", { instanceId: "i-999" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("delete_record", { id: "1" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("drop_database", { name: "prod" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("destroy_cluster", { id: "c-1" })
      ).toBe("user-approval");
    });

    it("flags destructive verbs in slugged MCP names (slug__tool)", async () => {
      // The chat route no longer blanket-gates dynamic tools; slugged
      // destructive names must still trip the verb gate on their own.
      expect(
        await evaluateToolApproval("acme__delete_account", { id: "u-1" })
      ).toBe("user-approval");
      expect(
        await evaluateToolApproval("my-db__drop_table", { table: "orders" })
      ).toBe("user-approval");
    });

    it("auto-approves safe slugged MCP research tools", async () => {
      // Regression for the frozen parallel-search approval: safe dynamic
      // MCP tools must run without user approval (spec scopes approvals
      // to destructive verbs only).
      expect(
        await evaluateToolApproval("parallel-search__web_search", {
          objective: "research",
          search_queries: ["test"],
        })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("parallel-search__web_fetch", {
          url: "https://example.com",
        })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("acme__get_stock_price", { symbol: "A" })
      ).toBeUndefined();
    });
  });

  describe("Safe tools and commands that are auto-approved", () => {
    it("auto-approves safe read-only operations", async () => {
      expect(
        await evaluateToolApproval("web_search", { query: "Next.js 16 docs" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("web_fetch", { url: "https://example.com" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("readFile", { path: "src/index.ts" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("projectReadFile", { path: "package.json" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("projectListFiles", {})
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("memory_search", { query: "preferences" })
      ).toBeUndefined();
    });

    it("auto-approves interactive and state tools", async () => {
      expect(
        await evaluateToolApproval("ask_user_question", {
          questions: [
            {
              question: "Choose framework",
              header: "Framework",
              options: [
                { label: "React", description: "UI library" },
                { label: "Vue", description: "Progressive framework" },
              ],
            },
          ],
        })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("task_list_manager", { title: "Plan", items: [] })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("memory_note_create", { content: "note" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("memory_fact_store", { content: "fact" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("artifact_publish", { title: "Art", kind: "code" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("memory_note_delete", { id: "123" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("reminder_schedule", { title: "Drink water", delayMinutes: 10 })
      ).toBeUndefined();
    });

    it("auto-approves skill reading and catalog tools", async () => {
      expect(
        await evaluateToolApproval("use_skill", { name: "test" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("use_skill", { name: "test", path: "a.md" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("skills_catalog", {})
      ).toBeUndefined();
    });

    it("auto-approves non-destructive bash commands", async () => {
      expect(
        await evaluateToolApproval("bash", { command: "ls -la" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("bash", { command: "git status" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("bash", { command: "git log -n 5" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("bash", { command: "pnpm test" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("bash", { command: "cat src/lib/ai/tools.ts" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("bash", { command: "echo 'hello world'" })
      ).toBeUndefined();
      expect(
        await evaluateToolApproval("bash", { command: "node -e 'console.log(1)'" })
      ).toBeUndefined();
    });

    it("handles invalid or unexpected input formats gracefully without throwing", async () => {
      expect(await evaluateToolApproval("bash", null)).toBeUndefined();
      expect(await evaluateToolApproval("bash", undefined)).toBeUndefined();
      expect(await evaluateToolApproval("bash", "not an object")).toBeUndefined();
      expect(await evaluateToolApproval("bash", {})).toBeUndefined();
      expect(await evaluateToolApproval("unknown_tool", { any: "thing" })).toBeUndefined();
    });
  });
});

describe("evaluateToolApproval — hardened coverage", () => {
  it("gates file_operations writes and edits, but not reads", async () => {
    // The project harness already routes file_operations through this engine;
    // without these rules that predicate was a silent no-op.
    expect(
      await evaluateToolApproval("file_operations", {
        action: "write",
        path: "src/x.ts",
        content: "x",
      })
    ).toBe("user-approval");
    expect(
      await evaluateToolApproval("file_operations", {
        action: "edit",
        path: "src/x.ts",
        oldString: "a",
        newString: "b",
      })
    ).toBe("user-approval");
    expect(
      await evaluateToolApproval("file_operations", {
        action: "read",
        path: "src/x.ts",
      })
    ).toBeUndefined();
  });

  it("detects destructive verbs across naming styles, and ignores lookalikes", async () => {
    // Bypasses of the old underscore-only regex.
    for (const name of [
      "postgres__dropTable",
      "someTool-delete-all",
      "deleteAll",
      "dropTable",
      "destroySession",
      "DELETE_ALL",
      "mcp_postgres_drop_table",
    ]) {
      expect(await evaluateToolApproval(name, {}), name).toBe("user-approval");
    }
    // "drop"/"delete" as a substring is not the verb.
    for (const name of [
      "dropdown_menu",
      "backdrop_render",
      "dropzone",
      "task_list_manager",
      "web_search",
    ]) {
      expect(await evaluateToolApproval(name, {}), name).toBeUndefined();
    }
    // The one documented exemption.
    expect(
      await evaluateToolApproval("memory_note_delete", {})
    ).toBeUndefined();
  });

  it("gates creating a persisted execution capability, but not a cron schedule", async () => {
    expect(
      await evaluateToolApproval("manage_mcp_server", { action: "create" })
    ).toBe("user-approval");
    expect(
      await evaluateToolApproval("manage_custom_tool", { action: "create" })
    ).toBe("user-approval");
    // A cron schedule is additive and reversible — still auto-approved.
    expect(
      await evaluateToolApproval("manage_cron_schedule", { action: "create" })
    ).toBeUndefined();
  });
});
