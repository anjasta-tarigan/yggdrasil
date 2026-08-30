import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import { setSettingsDb } from "@/lib/settings-service";
import {
  PROTECTED_TOOLS,
  TOOL_TOGGLES_KEY,
  filterToolsForChat,
  getDisabledTools,
  isToolEnabled,
  sanitizeDisabledTools,
  saveDisabledTools,
} from "@/lib/ai/tool-toggles";
import { chatTools } from "@/lib/ai/tools";

const KNOWN = Object.keys(chatTools);

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  setupFtsAndTriggers(sqlite);
  return drizzle(sqlite, { schema });
}

describe("tool toggles", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
  });

  describe("sanitizeDisabledTools (pure validation)", () => {
    it("accepts an empty list (re-enable everything)", () => {
      expect(sanitizeDisabledTools([])).toEqual([]);
    });

    it("accepts known tool names, preserves order, dedupes", () => {
      const out = sanitizeDisabledTools([
        "web_search",
        "web_search",
        "reminder_schedule",
      ]);
      expect(out).toEqual(["web_search", "reminder_schedule"]);
    });

    it("rejects unknown tool names", () => {
      expect(sanitizeDisabledTools(["no_such_tool"])).toBeNull();
    });

    it("rejects non-string entries", () => {
      expect(sanitizeDisabledTools([42 as unknown as string])).toBeNull();
      expect(sanitizeDisabledTools([null as unknown as string])).toBeNull();
    });

    it("rejects protected tools (ask_user_question)", () => {
      expect(sanitizeDisabledTools(["ask_user_question"])).toBeNull();
      // Even mixed with valid names, the whole payload is rejected.
      expect(
        sanitizeDisabledTools(["web_search", "ask_user_question"])
      ).toBeNull();
    });

    it("rejects non-array input", () => {
      expect(sanitizeDisabledTools(null)).toBeNull();
      expect(sanitizeDisabledTools("web_search")).toBeNull();
      expect(sanitizeDisabledTools({})).toBeNull();
    });

    it("rejects lists over the size bound", () => {
      expect(sanitizeDisabledTools(new Array(101).fill("web_search"))).toBeNull();
      expect(sanitizeDisabledTools(new Array(100).fill("web_search"))).toEqual([
        "web_search",
      ]);
    });
  });

  describe("getDisabledTools (read-time sanitization)", () => {
    it("returns [] when nothing is stored", () => {
      expect(getDisabledTools(db)).toEqual([]);
    });

    it("returns the stored disabled list", () => {
      setSettingsDb(
        { [TOOL_TOGGLES_KEY]: { disabled: ["web_search"] } },
        db
      );
      expect(getDisabledTools(db)).toEqual(["web_search"]);
    });

    it("drops unknown names from a hand-edited store row", () => {
      setSettingsDb(
        {
          [TOOL_TOGGLES_KEY]: {
            disabled: ["web_search", "deleted_tool", "not_even_a_tool"],
          },
        },
        db
      );
      expect(getDisabledTools(db)).toEqual(["web_search"]);
    });

    it("drops protected names from a hand-edited store row", () => {
      setSettingsDb(
        { [TOOL_TOGGLES_KEY]: { disabled: ["ask_user_question"] } },
        db
      );
      expect(getDisabledTools(db)).toEqual([]);
    });

    it("survives arbitrary garbage in the store", () => {
      setSettingsDb(
        { [TOOL_TOGGLES_KEY]: { disabled: [42, null, {}, ""] } },
        db
      );
      expect(getDisabledTools(db)).toEqual([]);
      setSettingsDb({ [TOOL_TOGGLES_KEY]: "garbage" }, db);
      expect(getDisabledTools(db)).toEqual([]);
      setSettingsDb({ [TOOL_TOGGLES_KEY]: null }, db);
      expect(getDisabledTools(db)).toEqual([]);
    });
  });

  describe("isToolEnabled", () => {
    it("is true for enabled tools and false for disabled ones", () => {
      setSettingsDb(
        { [TOOL_TOGGLES_KEY]: { disabled: ["web_search"] } },
        db
      );
      expect(isToolEnabled("web_search", db)).toBe(false);
      expect(isToolEnabled("reminder_schedule", db)).toBe(true);
    });

    it("is always true for protected tools", () => {
      setSettingsDb(
        { [TOOL_TOGGLES_KEY]: { disabled: ["ask_user_question"] } },
        db
      );
      expect(isToolEnabled("ask_user_question", db)).toBe(true);
    });
  });

  describe("saveDisabledTools", () => {
    it("persists the sanitized list", () => {
      const out = saveDisabledTools(["web_search", "web_fetch"], db);
      expect(out).toEqual(["web_search", "web_fetch"]);
      expect(getDisabledTools(db)).toEqual(["web_search", "web_fetch"]);
    });

    it("persists nothing when validation fails", () => {
      const out = saveDisabledTools(["unknown_tool"], db);
      expect(out).toBeNull();
      expect(getDisabledTools(db)).toEqual([]);
    });

    it("clears the list on empty input", () => {
      saveDisabledTools(["web_search"], db);
      const out = saveDisabledTools([], db);
      expect(out).toEqual([]);
      expect(getDisabledTools(db)).toEqual([]);
    });
  });

  describe("filterToolsForChat", () => {
    it("removes disabled tools from a toolset", () => {
      setSettingsDb(
        { [TOOL_TOGGLES_KEY]: { disabled: ["web_search", "web_fetch"] } },
        db
      );
      const tools = {
        web_search: {},
        web_fetch: {},
        reminder_schedule: {},
      } as unknown as Parameters<typeof filterToolsForChat>[0];
      const filtered = filterToolsForChat(tools, db);
      expect(Object.keys(filtered).sort()).toEqual(["reminder_schedule"]);
    });

    it("returns the same toolset when nothing is disabled", () => {
      const tools = { web_search: {}, reminder_schedule: {} } as unknown as Parameters<
        typeof filterToolsForChat
      >[0];
      const filtered = filterToolsForChat(tools, db);
      expect(Object.keys(filtered).sort()).toEqual([
        "reminder_schedule",
        "web_search",
      ]);
    });

    it("is a no-op (same reference) when the disabled set is empty", () => {
      const tools = {} as Parameters<typeof filterToolsForChat>[0];
      expect(filterToolsForChat(tools, db)).toBe(tools);
    });

    it("never removes ask_user_question even if the store was hand-edited", () => {
      setSettingsDb(
        { [TOOL_TOGGLES_KEY]: { disabled: ["ask_user_question"] } },
        db
      );
      const tools = { ask_user_question: {} } as unknown as Parameters<
        typeof filterToolsForChat
      >[0];
      expect(filterToolsForChat(tools, db)).toEqual({ ask_user_question: {} });
    });
  });

  describe("registry coherence", () => {
    it("PROTECTED_TOOLS names exist in the live chatTools registry", () => {
      for (const name of PROTECTED_TOOLS) {
        expect(KNOWN).toContain(name);
      }
    });

    it("every known tool is a plausible toggle candidate (names are stable strings)", () => {
      for (const name of KNOWN) {
        expect(typeof name).toBe("string");
        expect(name.length).toBeGreaterThan(0);
        expect(name.length).toBeLessThanOrEqual(128);
      }
    });
  });
});
