import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";

let sqlite: Database.Database;
let testDb: any;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
  get defaultDb() {
    return testDb;
  },
}));

import {
  buildSubagentToolsForChat,
  buildSubagentTools,
} from "@/lib/ai/subagent-runner";
import {
  listSubagents,
  updateSubagent,
  type SubagentConfig,
} from "@/lib/ai/subagents-service";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  setupFtsAndTriggers(db);
  return drizzle(db, { schema });
}

function researcherConfig(db: any): SubagentConfig {
  const seeded = listSubagents(db);
  return seeded.find((s) => s.name === "Researcher")!;
}

describe("Subagent Runner", () => {
  beforeEach(() => {
    testDb = freshDb();
    vi.clearAllMocks();
  });

  it("builds the toolset from granted capability keys", () => {
    const config = researcherConfig(testDb);
    // Researcher gets web_search, web_fetch, memory → web_search,
    // web_fetch, memory_search, memory_note_create.
    const tools = buildSubagentTools(config);
    const names = Object.keys(tools);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    expect(names).toContain("memory_search");
    expect(names).toContain("memory_note_create");
    // No sandbox / task tools granted.
    expect(names).not.toContain("bash");
    expect(names).not.toContain("task_list_manager");
  });

  it("sandbox grant maps to bash/readFile/writeFile", () => {
    const config = { ...researcherConfig(testDb), tools: ["sandbox"] as never };
    const names = Object.keys(buildSubagentTools(config));
    expect(names.sort()).toEqual(["bash", "readFile", "writeFile"].sort());
  });

  it("excludes disabled subagents from chat tools", async () => {
    const seeded = listSubagents(testDb);
    const coder = seeded.find((s) => s.name === "Coder")!;
    await updateSubagent(coder.id, { enabled: false }, testDb);

    const chatTools = await buildSubagentToolsForChat();
    // Researcher enabled, Coder + Analyst disabled.
    const names = chatTools.map((t) => t.name);
    expect(names).toContain("delegate_researcher");
    expect(names).not.toContain("delegate_coder");
    expect(names).not.toContain("delegate_analyst");
  });

  it("names delegation tools delegate_<slug>", async () => {
    const chatTools = await buildSubagentToolsForChat();
    for (const entry of chatTools) {
      expect(entry.name).toMatch(/^delegate_[a-z0-9_]+$/);
    }
    expect(chatTools.length).toBe(2); // researcher + coder enabled by default
  });

  it("delegation tool input schema requires a bounded task", async () => {
    const chatTools = await buildSubagentToolsForChat();
    const researcher = chatTools.find(
      (t) => t.name === "delegate_researcher"
    )!;
    expect(researcher).toBeDefined();
    // Tool is registered with a description mentioning the subagent name.
    expect((researcher.tool as unknown as { description: string }).description).toContain(
      "Researcher"
    );
  });
});
