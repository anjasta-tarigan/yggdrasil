import { describe, it, expect } from "vitest";
import { start } from "workflow/api";
import { readBackWorkflow } from "./gate5-workflow";

describe("gate 5 — stream read-back", () => {
  it("a step draining its own run's stream", async () => {
    const run = await start(readBackWorkflow, []);
    const out = await run.returnValue;
    console.log("GATE5 READBACK:", JSON.stringify(out));
    expect(out).toBeDefined();
  }, 60_000);
});
