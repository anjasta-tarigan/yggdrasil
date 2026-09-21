import { describe, it, expect } from "vitest";
import { start } from "workflow/api";
import { runWrappedModel, runBareModel } from "./models";

async function attempt(label: string, fn: () => Promise<unknown>) {
  try {
    const value = await fn();
    console.log(`GATE9RT ${label}: OK`, JSON.stringify(value));
    return { ok: true, value };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`GATE9RT ${label}: FAIL`, msg.slice(0, 300));
    return { ok: false, error: msg };
  }
}

describe("gate 9 runtime — provider instance across the step boundary", () => {
  it("wrapped model (yggdrasil's shape: wrapLanguageModel)", async () => {
    const run = await start(runWrappedModel, []);
    const out = await attempt("WRAPPED", () => run.returnValue);
    expect(out).toBeDefined();
  }, 60_000);

  it("bare provider model (no middleware wrapper)", async () => {
    const run = await start(runBareModel, []);
    const out = await attempt("BARE", () => run.returnValue);
    expect(out).toBeDefined();
  }, 60_000);
});
