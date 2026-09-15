import path from "node:path";
import type { DiscoveredModel } from "@/lib/models/store";
import type { ServiceHealth } from "@/hooks/use-system-health";
import type {
  EmbeddingConfig,
  OnnxEmbeddingStatus,
} from "@/lib/memory/embeddings";
import type { RerankerStatus } from "@/lib/memory/reranker";

/**
 * Friendly provider label for the mini footer. Collapses the provider kind into
 * the handful of names a user would recognize: "openai", "ollama", and the
 * registry "server" fallback ("self-host" conveys it better in a one-token
 * label than the raw "server" id).
 */
function providerLabel(provider: EmbeddingConfig["provider"]): string {
  if (provider === "openai-compatible") return "openai";
  if (provider === "server") return "self-host";
  return provider; // "onnx" | "ollama"
}

/**
 * Resolve a human-readable model name for display (not a file path):
 *   1. an explicit, user-configured name (e.g. "text-embedding-3-small" or a
 *      custom on-device label) always wins;
 *   2. otherwise the installed model's HuggingFace repo leaf
 *      ("Xenova/bge-small-en-v1.5" → "bge-small-en-v1.5") — accurate for
 *      models installed via the toolchain (which write a manifest);
 *   3. otherwise the model-file basename with the `.onnx` extension stripped —
 *      the honest best-effort for a hand-placed legacy file.
 */
export function resolveModelName(
  configuredName: string | undefined,
  modelPath: string | null,
  discovered: DiscoveredModel[] = []
): string | null {
  if (configuredName) return configuredName;
  if (!modelPath) return null;

  const match = discovered.find(
    (m) => m.path === modelPath && typeof m.repo === "string"
  );
  if (match?.repo) {
    const parts = match.repo.split("/");
    return parts[parts.length - 1] ?? match.repo;
  }

  const stem = path.basename(modelPath).replace(/\.onnx$/, "");
  return stem.length > 0 ? stem : null;
}

/**
 * Map a resolved embedding config + its ONNX diagnostic onto the shared
 * lifecycle vocabulary used by the mini footer.
 *
 * Remote providers (openai-compatible / ollama / server) are always-on
 * endpoints — they have no lazy-load "standby" state, so a configured base
 * URL means running, and an absent one means unload.
 */
export function mapEmbeddingHealth(
  config: EmbeddingConfig,
  onnxStatus: OnnxEmbeddingStatus | null,
  discovered: DiscoveredModel[] = []
): ServiceHealth {
  if (config.provider === "onnx" && onnxStatus) {
    const hasModel = onnxStatus.modelPath !== null;
    const status: ServiceHealth["status"] = onnxStatus.loaded
      ? "running"
      : hasModel
        ? "standby"
        : "unload";
    return {
      status,
      provider: "onnx",
      // The ONNX embedding model is file-based: its display name comes from
      // the on-disk file (repo leaf / filename stem), NEVER from `config.model`.
      // That field is never written by the ONNX settings UI (only `modelPath`
      // + `poolingMode` are) and is not JSON-serialized back, so any value
      // present is a stale leftover from a prior provider (e.g. an OpenRouter
      // model id). Letting it win would surface "another provider's" model in
      // the footer. Pass `undefined` so resolveModelName falls through to the
      // discovered repo leaf / filename stem — the real on-device model.
      model: resolveModelName(
        undefined,
        onnxStatus.modelPath ?? config.modelPath ?? null,
        discovered
      ),
      loaded: onnxStatus.loaded,
    };
  }

  // Remote provider: running when an endpoint is configured.
  const status: ServiceHealth["status"] = config.baseUrl ? "running" : "unload";
  return {
    status,
    provider: providerLabel(config.provider),
    model: config.model ?? null,
    loaded: false,
  };
}

/**
 * Map the reranker's richer diagnostic onto the shared lifecycle vocabulary.
 * - active   → running  (session loaded in memory)
 * - standby  → standby  (model file ready, session evicted)
 * - fallback / disabled → unload
 */
export function mapRerankerHealth(
  status: RerankerStatus,
  discovered: DiscoveredModel[] = []
): ServiceHealth {
  const lifecycle: ServiceHealth["status"] =
    status.mode === "active"
      ? "running"
      : status.mode === "standby"
        ? "standby"
        : "unload";
  return {
    status: lifecycle,
    provider: status.enabled ? "onnx" : "disabled",
    model: resolveModelName(undefined, status.modelPath, discovered),
    loaded: status.loaded,
  };
}

/** A service whose provider is entirely unreachable / unconfigured. */
export function unloadedService(provider = "unconfigured"): ServiceHealth {
  return { status: "unload", provider, model: null, loaded: false };
}
