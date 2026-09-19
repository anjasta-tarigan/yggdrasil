// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createHfClient } from "../hf-client";
import { planInstall } from "../installer";

describe("models installer integration", () => {
  it("fetches real tree and plans install for Xenova/all-MiniLM-L6-v2", async () => {
    // Gated: skip gracefully if the HuggingFace API is unreachable
    // (e.g. in CI without network access).
    try {
      const probe = await fetch("https://huggingface.co", {
        signal: AbortSignal.timeout(5000),
      });
      if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    } catch (err) {
      console.debug(`[test] Catch: ${err instanceof Error ? err.message : String(err)}`);
      console.warn("Skipping integration test — HuggingFace API unreachable");
      return;
    }

    const client = createHfClient();
    const plan = await planInstall({
      repo: "Xenova/all-MiniLM-L6-v2",
      kind: "embedding",
      client,
    });
    expect(plan.files.length).toBeGreaterThan(0);
    expect(
      plan.files.some((f) => f.destinationRelPath === "tokenizer.json"),
    ).toBe(true);
  });
});
