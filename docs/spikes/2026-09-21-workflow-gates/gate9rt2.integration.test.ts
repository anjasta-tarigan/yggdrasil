import { describe, it, expect } from "vitest";
import { start } from "workflow/api";
import { runLocalHolder, readSeen } from "./registration";

describe("gate 9 runtime round 2 — local serializable class", () => {
  it("a locally-defined serializable class crosses the boundary", async () => {
    const run = await start(runLocalHolder, []);
    let outcome: unknown;
    try {
      outcome = { ok: true, value: await run.returnValue };
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    console.log("GATE9RT2 LOCAL CLASS:", JSON.stringify(outcome));
    console.log("GATE9RT2 SEEN:", JSON.stringify(readSeen()));
    expect(outcome).toBeDefined();
  }, 60_000);
});
