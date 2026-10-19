/**
 * Environment-gated end-to-end integration test for llama-server.
 *
 * Skipped unless `LLAMA_TEST_BINARY` and `LLAMA_TEST_MODEL` are BOTH set —
 * the test needs a real llama-server binary and a real .gguf model.
 *
 * Setup:
 *   1. Install llama-server (build 6000+): `curl -LsSf https://llama.app/install.sh | sh`
 *   2. Download a tiny model (e.g. Qwen2.5-0.5B-Instruct Q8_0, ~500 MB).
 *   3. Point GGUF_MODELS_DIR at the directory that holds the .gguf file —
 *      the runner resolves the model as `<GGUF_MODELS_DIR>/<basename>`.
 *      By default that is `data/models/GGUF-chatModel/`, so a plain copy or
 *      symlink of the model into that directory works too.
 *   4. Run:
 *        GGUF_MODELS_DIR=/path/to/models \
 *        LLAMA_TEST_BINARY=/path/to/llama-server \
 *        LLAMA_TEST_MODEL=/path/to/models/tiny-q8_0.gguf \
 *        npx vitest run src/lib/llama/__tests__/gguf-server.integration.test.ts
 *
 * The test exercises the REAL runner (`ensureGgufServerRunning` → spawn →
 * /health + /props → /v1/models → chat round-trip), so a failure here means
 * the planner's flags or the server contract are wrong against a real server.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { browseProviderModels } from "@/lib/ai/models";
import {
  setProviderConfigPathsForTest,
  saveRegistry,
} from "@/lib/ai/provider-config/store";
import type { ProviderEntry } from "@/lib/ai/provider-config/schema";
import { modelsDirPath } from "@/lib/llama/detect";
import { planServerFlags } from "@/lib/llama/resource-planner";
import {
  ensureGgufServerRunning,
  stopGgufServer,
} from "@/lib/llama/runner";

const BINARY = process.env.LLAMA_TEST_BINARY;
const MODEL = process.env.LLAMA_TEST_MODEL;
const describeIf = BINARY && MODEL ? describe : describe.skip;

const PROVIDER_ID = "gguf-integration";
const MODEL_ID = path.basename(MODEL ?? "");

describeIf("gguf-server integration (env-gated)", () => {
  let registryDir: string;
  let modelDir: string;

  beforeAll(async () => {
    // The runner writes a pidfile next to the models and persists a reassigned
    // port into the registry — both are process-global paths, so point them
    // at throwaway directories for the duration of the test.
    registryDir = await mkdtemp(path.join(tmpdir(), "ygg-gguf-it-registry-"));
    setProviderConfigPathsForTest(registryDir);
    await saveRegistry({ version: 1, providers: [] });

    modelDir = await mkdtemp(path.join(tmpdir(), "ygg-gguf-it-models-"));
    process.env.GGUF_MODELS_DIR = modelDir;
    // The runner resolves the model as <modelsDir>/<modelId>.
    await symlink(MODEL!, path.join(modelDir, MODEL_ID)).catch(() => {
      throw new Error(
        `could not link ${MODEL} into ${modelDir} — the runner resolves the model by basename`,
      );
    });
  }, 60_000);

  afterAll(async () => {
    await stopGgufServer(PROVIDER_ID, MODEL_ID).catch(() => {});
    delete process.env.GGUF_MODELS_DIR;
    if (registryDir) await rm(registryDir, { recursive: true, force: true });
    if (modelDir) await rm(modelDir, { recursive: true, force: true });
  });

  it("plans flags the server accepts and serves health, models and chat", async () => {
    const { stat } = await import("node:fs/promises");
    const os = await import("node:os");
    const sizeBytes = (await stat(MODEL!)).size;

    const planned = planServerFlags({
      filename: MODEL_ID,
      modelSizeBytes: sizeBytes,
      modelCtxCap: null,
      profile: {
        cpuCores: os.cpus().length,
        totalMemBytes: os.totalmem(),
        freeMemBytes: os.freemem(),
      },
    });
    // The unknown-flag fallback must not have stripped a supported flag.
    expect(planned.args).toContain("--jinja");
    expect(modelsDirPath()).toBe(modelDir);

    const entry: ProviderEntry = {
      id: PROVIDER_ID,
      kind: "gguf-model",
      name: "GGUF integration",
      baseUrl: "http://127.0.0.1:2301",
      gguf: { serverPath: BINARY! },
      models: [
        {
          modelId: MODEL_ID,
          displayName: MODEL_ID.replace(/\.gguf$/i, ""),
          isDefault: true,
          capabilities: {
            contextWindow: null,
            maxOutputTokens: null,
            inputModalities: ["text"],
            outputModalities: ["text"],
            supportsToolCalls: null,
            supportsReasoning: null,
          },
          capabilitySources: {},
        },
      ],
    };

    const baseUrl = await ensureGgufServerRunning(entry, MODEL_ID);
    try {
      const health = await (await fetch(`${baseUrl}/health`)).json();
      expect(health.status).toBe("ok");

      const models = await (await fetch(`${baseUrl}/v1/models`)).json();
      expect(JSON.stringify(models)).toContain("gguf");

      // The providers/models route browses the same OpenAI-compatible shape.
      const browsed = await browseProviderModels(
        baseUrl,
        undefined,
        "openai-compatible",
      );
      expect(browsed.length).toBeGreaterThan(0);

      const chat = await (
        await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: MODEL_ID,
            messages: [{ role: "user", content: "Say ok." }],
            max_tokens: 16,
          }),
        })
      ).json();
      expect(chat.choices?.[0]?.message?.content?.length ?? 0).toBeGreaterThan(0);
    } finally {
      await stopGgufServer(PROVIDER_ID, MODEL_ID);
    }
  }, 180_000);
});
