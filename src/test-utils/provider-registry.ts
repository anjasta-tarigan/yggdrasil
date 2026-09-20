import fs from "node:fs/promises";
import path from "node:path";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  saveRegistry,
  setProviderConfigPathsForTest,
} from "@/lib/ai/provider-config/store";
import type { RegistryDocument } from "@/lib/ai/provider-config/schema";

/**
 * Shared test helpers for the Projects API suites.
 *
 * The route resolves the requested model against the provider registry
 * (`loadRegistry()`), then builds an OpenAI-compatible model from the entry.
 * A clean checkout has no `data/providers.json` (it is gitignored), so
 * `loadRegistry()` throws `ProviderConfigError` and the route answers 500.
 * Seeding an isolated registry — plus swapping `chatModelForEntry` for a
 * scripted model — makes the suites hermetic: no developer registry, no
 * network. The developer's real `data/providers.json` is never touched
 * (`setProviderConfigPathsForTest` repoints the module-level paths).
 */

/** A unique temp directory for a test's provider registry. */
export function createTestProviderRegistryDir(prefix: string): string {
  const tmpDir =
    process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
  return path.join(tmpDir, `${prefix}-${process.pid}-${Date.now()}`);
}

/**
 * The canonical test registry: a default ollama entry (needs no API key) so
 * default-model requests resolve, plus a `supportsToolCalls: false` model so
 * the harness capability guard can be exercised.
 */
export function testProviderRegistryDocument(): RegistryDocument {
  const capabilities = (supportsToolCalls: boolean | null) => ({
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: ["text"] as ("text" | "image" | "audio" | "video" | "pdf")[],
    outputModalities: ["text"] as ("text" | "image" | "audio" | "video" | "pdf")[],
    supportsToolCalls,
    supportsReasoning: null,
  });

  return {
    version: 1,
    providers: [
      {
        id: "test",
        kind: "ollama",
        name: "Test provider",
        baseUrl: "http://localhost:11434",
        models: [
          {
            modelId: "test-model",
            displayName: "Test Model",
            isDefault: true,
            capabilities: capabilities(null),
            capabilitySources: {},
          },
          {
            modelId: "no-tools-model",
            displayName: "No Tools Model",
            isDefault: false,
            capabilities: capabilities(false),
            capabilitySources: {},
          },
        ],
      },
    ],
  };
}

/**
 * Point the provider-config store at `dir` and write the test registry into
 * it. Idempotent: safe to call from `beforeAll`.
 */
export async function seedTestProviderRegistry(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  setProviderConfigPathsForTest(dir);
  await saveRegistry(testProviderRegistryDocument());
}

/** Remove a registry directory created by {@link createTestProviderRegistryDir}. */
export async function cleanupTestProviderRegistry(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export interface ScriptedChatModelOptions {
  /** Text streamed when the model does not throw. */
  text?: string;
  /**
   * When this returns true, `doStream` throws an AI-SDK timeout
   * `DOMException` instead of streaming — used to exercise the harness
   * loop's timeout interceptor and the route's client-facing mapper.
   */
  shouldThrowTimeout?: () => boolean;
  /** Label used in the thrown timeout message (default `"first chunk"`). */
  timeoutLabel?: string;
  /** Timeout duration in the thrown message (default `90_000`). */
  timeoutMs?: number;
}

/**
 * A scripted `LanguageModelV4` that streams a short reply (or throws a
 * timeout error). Records every call's provider options in `doStreamCalls`,
 * so tests can assert what the harness actually sent.
 */
export function createScriptedChatModel(
  options: ScriptedChatModelOptions = {}
): MockLanguageModelV4 {
  const { text = "pong", shouldThrowTimeout, timeoutLabel = "first chunk", timeoutMs = 90_000 } =
    options;

  return new MockLanguageModelV4({
    provider: "test",
    modelId: "test-model",
    doStream: async () => {
      if (shouldThrowTimeout?.()) {
        throw new DOMException(
          `${timeoutLabel} timeout of ${timeoutMs}ms exceeded`,
          "TimeoutError"
        );
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            { type: "text-start" as const, id: "t1" },
            { type: "text-delta" as const, id: "t1", delta: text },
            { type: "text-end" as const, id: "t1" },
            {
              type: "finish" as const,
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
              finishReason: { unified: "stop" as const, raw: "stop" },
            },
          ],
        }),
      };
    },
  });
}
