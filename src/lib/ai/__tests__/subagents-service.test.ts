import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import type { AppDatabase } from "@/db";
import { setSettingsDb } from "@/lib/settings-service";

let testDb: AppDatabase;

vi.mock("@/db", () => ({
  get db() {
    return testDb;
  },
  get defaultDb() {
    return testDb;
  },
}));

import {
  BUILT_IN_SUBAGENTS,
  SUBAGENT_TOOL_REGISTRY,
  SubagentValidationError,
  createSubagent,
  deleteSubagent,
  listEnabledSubagents,
  listSubagents,
  slugifySubagentName,
  updateSubagent,
} from "@/lib/ai/subagents-service";

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  setupFtsAndTriggers(db);
  return drizzle(db, { schema });
}

function makeValidInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Researcher",
    instructions: "You are a research agent.",
    tools: ["web_search", "memory"] as Array<string>,
    ...overrides,
  } as never;
}

describe("Subagents Service", () => {
  beforeEach(() => {
    testDb = freshDb();
  });

  it("seeds built-in subagents on first access", () => {
    const subs = listSubagents(testDb);
    expect(subs.length).toBe(BUILT_IN_SUBAGENTS.length);
    expect(subs.map((s) => s.name)).toEqual(
      expect.arrayContaining(["Researcher", "Coder", "Analyst"])
    );
    // Stable ids derived from the name.
    expect(subs.some((s) => s.id === "sub_researcher")).toBe(true);
    // Enabled filter: Analyst ships disabled.
    const enabled = listEnabledSubagents(testDb);
    expect(enabled.map((s) => s.name)).not.toContain("Analyst");
    expect(enabled.length).toBe(2);
  });

  it("persists across list calls (settings store)", () => {
    listSubagents(testDb); // seed
    const again = listSubagents(testDb);
    expect(again.length).toBe(BUILT_IN_SUBAGENTS.length);
  });

  it("creates a subagent with defaults", async () => {
    listSubagents(testDb); // seed first so we see the created row separately
    const created = await createSubagent(
      makeValidInput({ name: "Writer" }),
      testDb
    );
    expect(created.id).toMatch(/^sub_/);
    expect(created.enabled).toBe(true);
    expect(created.maxSteps).toBe(12);
    expect(created.model).toBeUndefined();

    const all = listSubagents(testDb);
    expect(all.length).toBe(BUILT_IN_SUBAGENTS.length + 1);
  });

  it("rejects invalid input with per-field errors", async () => {
    const issues = await createSubagent(
      makeValidInput({
        name: "   ",
        instructions: "",
        tools: ["not_a_tool"],
        maxSteps: 999,
      }),
      testDb
    ).catch((err: unknown) => {
      expect(err).toBeInstanceOf(SubagentValidationError);
      const e = err as SubagentValidationError;
      return e.issues;
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("name"),
        expect.stringContaining("instructions"),
        expect.stringContaining("tools"),
        expect.stringContaining("maxSteps"),
      ])
    );
  });

  it("rejects duplicate slugs (name collisions)", async () => {
    listSubagents(testDb); // seeds "Researcher"
    await expect(
      createSubagent(makeValidInput({ name: "researcher" }), testDb)
    ).rejects.toBeInstanceOf(SubagentValidationError);
  });

  it("updates fields, enforces uniqueness on rename", async () => {
    const seeded = listSubagents(testDb);
    const researcher = seeded.find((s) => s.name === "Researcher")!;
    const updated = await updateSubagent(
      researcher.id,
      { maxSteps: 25, description: "Updated desc" },
      testDb
    );
    expect(updated?.maxSteps).toBe(25);
    expect(updated?.description).toBe("Updated desc");
    expect(updated?.name).toBe("Researcher");

    // Renaming Coder to "researcher" must collide.
    const coder = seeded.find((s) => s.name === "Coder")!;
    await expect(
      updateSubagent(coder.id, { name: "Researcher" }, testDb)
    ).rejects.toBeInstanceOf(SubagentValidationError);
  });

  it("updateSubagent returns null for unknown id", async () => {
    expect(await updateSubagent("sub_ghost", { name: "X" }, testDb)).toBeNull();
  });

  it("deletes a subagent", () => {
    const seeded = listSubagents(testDb);
    const analyst = seeded.find((s) => s.name === "Analyst")!;
    const removed = deleteSubagent(analyst.id, testDb);
    expect(removed?.id).toBe(analyst.id);
    expect(listSubagents(testDb).length).toBe(seeded.length - 1);
    expect(deleteSubagent(analyst.id, testDb)).toBeNull();
  });

  it("tool registry entries are unique with non-empty tool lists", () => {
    const keys = SUBAGENT_TOOL_REGISTRY.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of SUBAGENT_TOOL_REGISTRY) {
      expect(entry.toolNames.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("slugifySubagentName produces safe tool suffixes", () => {
    expect(slugifySubagentName("Code Reviewer")).toBe("code_reviewer");
    expect(slugifySubagentName("  Web--Search!! ")).toBe("web_search");
    expect(slugifySubagentName("Ünicode 名")).toBe("nicode");
  });

  it("caps stored subagents at the limit", async () => {
    listSubagents(testDb);
    // Fill to the cap (built-ins count against it).
    let lastError: unknown = null;
    let created = BUILT_IN_SUBAGENTS.length;
    for (let i = 0; i < 30; i++) {
      try {
        await createSubagent(
          makeValidInput({ name: `Agent ${i}`, tools: ["memory"] }),
          testDb
        );
        created++;
      } catch (err) {
        lastError = err;
        break;
      }
    }
    expect(lastError).toBeInstanceOf(SubagentValidationError);
    expect(listSubagents(testDb).length).toBe(20);
    expect(created).toBe(20);
  });

  it("drops malformed rows on read (shape guard)", () => {
    listSubagents(testDb); // seed
    const parsed = listSubagents(testDb);
    const corrupted: unknown[] = [
      ...parsed,
      { garbage: true },
      { ...parsed[0], id: 42, maxSteps: "lots" },
    ];
    setSettingsDb({ subagents: corrupted }, testDb);
    const after = listSubagents(testDb);
    // Malformed rows are silently filtered out; valid ones remain.
    expect(after.length).toBe(parsed.length);
    expect(after.every((s) => s.id.startsWith("sub_"))).toBe(true);
  });

  // ── Built-in tool rename migration ──────────────────────────────────

  it("migrates stored rows with the legacy fetch_page key at read time", () => {
    // Seed, then rewrite one row as a pre-rename shape (old key).
    const seeded = listSubagents(testDb);
    const researcher = seeded.find((s) => s.name === "Researcher")!;
    const legacyRow = { ...researcher, tools: ["web_search", "fetch_page", "memory"] };
    setSettingsDb({ subagents: [legacyRow, ...seeded.filter((s) => s.id !== researcher.id)] }, testDb);

    const after = listSubagents(testDb);
    const migrated = after.find((s) => s.id === researcher.id)!;
    expect(migrated.tools).toContain("web_fetch");
    expect(migrated.tools).not.toContain("fetch_page");
    // The migration persists — a second read returns the same normalized row.
    expect(listSubagents(testDb).find((s) => s.id === researcher.id)!.tools).toContain("web_fetch");
  });

  it("refreshes an uncustomized built-in whose instructions teach legacy tool names", () => {
    const seeded = listSubagents(testDb);
    const researcher = seeded.find((s) => s.name === "Researcher")!;
    // Simulate a v2-era row: old instructions + old maxSteps + old guidance,
    // with the pre-upgrade seed version marker so the refresh pass runs.
    const legacyRow = {
      ...researcher,
      instructions: "You are a research agent. Start with recall_memories, then web_search. fetch_page every source you rely on.",
      maxSteps: 12,
      delegationGuidance: "USE for: research.",
      tools: ["web_search", "fetch_page", "memory"],
    };
    setSettingsDb(
      {
        subagents: [legacyRow, ...seeded.filter((s) => s.id !== researcher.id)],
        subagentsSeedVersion: 2,
      },
      testDb
    );

    const after = listSubagents(testDb);
    const refreshed = after.find((s) => s.id === researcher.id)!;
    // Full seed refresh: instructions and guidance match the current seed.
    const seed = BUILT_IN_SUBAGENTS.find((s) => s.name === "Researcher")!;
    expect(refreshed.instructions).toBe(seed.instructions);
    expect(refreshed.delegationGuidance).toBe(seed.delegationGuidance);
    expect(refreshed.tools).toContain("web_fetch");
  });

  it("preserves a user-customized persona while rewriting its legacy tool names", () => {
    const seeded = listSubagents(testDb);
    const researcher = seeded.find((s) => s.name === "Researcher")!;
    // A user edit: distinctive persona text, but mentions old tool names.
    // Seed version reset to 2 simulates the pre-upgrade read.
    const customized = {
      ...researcher,
      instructions: "My custom research persona. Always fetch_page the primary source before answering, and open with recall_memories for context.",
    };
    setSettingsDb(
      {
        subagents: [customized, ...seeded.filter((s) => s.id !== researcher.id)],
        subagentsSeedVersion: 2,
      },
      testDb
    );

    const after = listSubagents(testDb);
    const row = after.find((s) => s.id === researcher.id)!;
    // The persona text survives…
    expect(row.instructions).toContain("My custom research persona.");
    expect(row.instructions).toContain("Always web_fetch the primary source");
    // …but the stale names are gone.
    expect(row.instructions).not.toMatch(/fetch_page|recall_memories/);
  });
});
