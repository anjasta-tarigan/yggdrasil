import { describe, it, expect } from "vitest";
import { start } from "workflow/api";
import { loadRegistry } from "@/lib/ai/provider-config/store";
import { toolsContextProbeWorkflow } from "./tools-context-probe";
import type { DurableModelInit } from "@/lib/ai/durable-model";

/**
 * Gate 9's end-to-end proof: a real `WorkflowAgent` turn must hand the per-tool
 * `toolsContext` entry to the tool's `execute` as `context`.
 *
 * The probe resolves the provider baseUrl + apiKey from the registry inside a step
 * (registry reads node:fs) and carries that plain data through the model's
 * serializable init, so the model rebuilds its provider after the doStreamStep
 * boundary. With a self-sufficient model the real turn completes and the tool
 * records what it saw.
 */
describe("toolsContext reaches tool execute", () => {
  it("passes the per-tool entry as `context`", async () => {
    const doc = await loadRegistry();
    const provider = doc.providers.find((p) => p.models.length > 0);
    if (!provider) {
      throw new Error(
        "No provider configured. Add one in Settings → Providers to run gate 9."
      );
    }
    // Use the provider's default model — models[0] may be a retired model whose
    // API now returns 410 Gone, which would mask the boundary verdict.
    const model = provider.models.find((m) => m.isDefault) ?? provider.models[0];

    const run = await start(toolsContextProbeWorkflow, [
      {
        providerId: provider.id,
        modelId: model.modelId,
        baseUrl: "",
        apiKey: "",
      } as DurableModelInit,
      "Call the probe tool now.",
    ]);
    const out = (await run.returnValue) as { observed: unknown };

    // The verdict this whole task exists to produce:
    expect(out.observed).not.toBeNull();
    expect(out.observed).toMatchObject({
      context: { canonicalRoot: "/tmp/probe-root", sessionId: "sess_probe" },
    });
  }, 120_000);
});
