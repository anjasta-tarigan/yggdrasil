import { describe, it, expect } from "vitest";
import { start } from "workflow/api";
import { loadRegistry } from "@/lib/ai/provider-config/store";
import { projectHarnessWorkflow } from "./project-harness-workflow";
import type { DurableModelInit } from "@/lib/ai/durable-model";

/**
 * Task 9 end-to-end: the durable harness workflow runs a real turn with the
 * step-ified bash tool. The model is asked to run a trivial bash command; if the
 * step-ified bash tool (which reads canonicalRoot/trusted from toolsContext) and
 * the workflow bundle (which must not pull node:fs into the workflow side) are
 * wired correctly, the turn completes with finishReason "stop".
 *
 * This also implicitly verifies the build constraint: the vitest workflow plugin
 * builds the workflow bundle on run, and a node:fs leak (via project-harness-tools)
 * would surface as a node-js-module-in-workflow error here.
 */
describe("project harness workflow runs a real turn", () => {
  it("completes a turn with the step-ified bash tool", async () => {
    const doc = await loadRegistry();
    const provider = doc.providers.find((p) => p.models.length > 0);
    if (!provider) throw new Error("No provider configured.");
    const model = provider.models.find((m) => m.isDefault) ?? provider.models[0];
    if (!model) throw new Error("No model configured.");

    // Raw ref only; the workflow resolves baseUrl/apiKey from the registry in a step.
    const rawInit: DurableModelInit = {
      providerId: provider.id,
      modelId: model.modelId,
      baseUrl: "",
      apiKey: "",
    };

    const run = await start(projectHarnessWorkflow, [
      {
        projectId: "proj_test",
        sessionId: "sess_test",
        directoryPath: process.cwd(),
        trusted: true,
        modelInit: rawInit,
        messages: [
          {
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "Run the bash command: echo hello-world" }],
          },
        ],
        budgetTokens: 40_000,
        systemPrompt:
          "You are a coding assistant. Use the bash tool to run the command the user asks for, then stop.",
      },
    ]);

    const out = (await run.returnValue) as { finishReason: string; stopReason: string };
    expect(out.finishReason).toBe("stop");
    // A single bash step should finish naturally, not hit the cap.
    expect(out.stopReason).toBe("natural");
  }, 120_000);
});
