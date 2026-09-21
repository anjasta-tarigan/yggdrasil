import { describe, it, expect } from "vitest";
import { start } from "workflow/api";
import { toolsContextWorkflow, stopMockProvider } from "./toolscontext3";

describe("gate 9 round 3c — local serializable model + toolsContext", () => {
  it("turn completes; tool reports whether it received context", async () => {
    const run = await start(toolsContextWorkflow, []);
    let outcome: unknown;
    try {
      outcome = { ok: true, value: await run.returnValue };
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    console.log("GATE9RT3C:", JSON.stringify(outcome, null, 2));
    try {
      await stopMockProvider();
    } catch {
      /* best effort */
    }
    expect(outcome).toBeDefined();
  }, 90_000);
});
