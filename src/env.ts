import { z } from "zod";

/**
 * Centralized environment schema (Rule 06 — Environment Invariant).
 *
 * Parse once at import time: every consumer reads validated values from
 * the exported `env` object instead of touching `process.env` directly.
 * Fail-fast on invalid required values; optional values default sensibly
 * or remain `undefined`.
 */
const envSchema = z.object({
  // Runtime context
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  NEXT_RUNTIME: z.string().optional(),
  VITEST: z.string().optional(),
  AI_SDK_DEVTOOLS_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .or(z.literal("").transform(() => undefined)),

  // Database
  DATABASE_PATH: z.string().optional(),

  // Embeddings (Rule 11 / Rule 12: retry + timeout tunables)
  EMBEDDING_FETCH_TIMEOUT_MS: z.coerce
    .number({ message: "EMBEDDING_FETCH_TIMEOUT_MS must be a number" })
    .int()
    .positive()
    .default(5000),
  EMBEDDING_MAX_RETRIES: z.coerce
    .number({ message: "EMBEDDING_MAX_RETRIES must be a number" })
    .int()
    .nonnegative()
    .default(2),
  EMBEDDING_RETRY_BASE_DELAY_MS: z.coerce
    .number({ message: "EMBEDDING_RETRY_BASE_DELAY_MS must be a number" })
    .int()
    .positive()
    .default(500),
  EMBEDDING_MODEL_ID: z.string().optional(),

  // Web search providers
  EXA_API_KEY: z.string().optional(),
  FIRECRAWL_API_KEY: z.string().optional(),
  SEARXNG_BASE_URL: z.string().url("SEARXNG_BASE_URL must be a valid URL").optional(),

  // Observability
  YGGDRASIL_LOG_DIR: z.string().optional(),
  YGGDRASIL_AGENT_METRIC_CAPACITY: z.coerce
    .number({ message: "YGGDRASIL_AGENT_METRIC_CAPACITY must be a number" })
    .int()
    .positive()
    .optional(),

  // Provider config
  YGGDRASIL_PROVIDER_CONFIG_DIR: z.string().optional(),
  YGGDRASIL_PROVIDER_CONFIG_SECRETS: z.string().optional(),

  // Skill/plugin directories
  SKILLS_DIR: z.string().optional(),
  PLUGINS_DIR: z.string().optional(),

  // Legacy LLM env vars (consumed by provider-config migration)
  LLM_BASE_URL: z.string().url("LLM_BASE_URL must be a valid URL").optional(),
  LLM_MODEL_ID: z.string().optional(),
  LLM_API_KEY: z.string().optional(),

  // Reranker (bge-reranker-v2-m3 ONNX INT8 — lazy-loaded on-demand)
  RERANKER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * Absolute path to model_quantized.onnx (INT8). If unset, defaults to
   * data/models/bge-reranker-v2-m3-int8.onnx. If absent, falls back to cosine RRF.
   */
  RERANKER_MODEL_PATH: z.string().optional(),
  /** ms to keep the ONNX session loaded after last use before releasing it. Defaults to 15 minutes. */
  RERANKER_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(900_000),
  /**
   * How many post-RRF candidates to feed into the reranker before slicing
   * to `limit`. Must be ≥ limit. Default 15 balances CPU latency and recall.
   */
  RERANKER_CANDIDATE_WINDOW: z.coerce
    .number()
    .int()
    .min(1)
    .default(15),

  // ONNX embedding model (lazy-loaded on-demand, mirrors reranker lifecycle)
  /** Directory scanned for .onnx embedding models. Defaults to data/models/embedding. */
  EMBEDDING_ONNX_DIR: z.string().optional(),
  /** ms to keep the ONNX embedding session loaded after last use before releasing it. */
  EMBEDDING_ONNX_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(120_000),

  // Sandbox environment passthrough
  PATH: z.string().optional(),
  HOME: z.string().optional(),
  LANG: z.string().optional(),

  // Additional provider/env vars
  OLLAMA_HOST: z.string().optional(),

  // Security (Rule 04 / Rule 06: AES-256-GCM data-at-rest encryption secret)
  APP_SECRET: z
    .string()
    .min(32, "APP_SECRET must be at least 32 characters long")
    .optional()
    .or(z.literal("").transform(() => undefined)),
}).superRefine((data, ctx) => {
  if (data.NODE_ENV === "production" && !data.APP_SECRET && !process.env.VITEST) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "APP_SECRET is required in production and must be at least 32 characters",
      path: ["APP_SECRET"],
    });
  }
});

export const env = envSchema.parse(process.env);

/**
 * Re-parses the schema from the current process.env. Call this when
 * environment values may have changed at runtime (e.g. provider API keys
 * rotated via the admin UI) and module-load-time values are stale.
 */
export function refreshEnv(): z.infer<typeof envSchema> {
  return envSchema.parse(process.env);
}
