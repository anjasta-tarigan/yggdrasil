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
  NEXT_PHASE: z.string().optional(),
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

  // ─── OOM / Memory Protection (Rule 07: Never Crash From Resource Exhaustion) ───
  /**
   * cgroup hard memory limit applied to the background service (systemd user unit).
   * Read at install time by `yggdrasil install`; overrides the auto-computed 80%.
   * Set to "0" to disable (not recommended — removes the safety net).
   */
  YGGDRASIL_MEMORY_MAX_BYTES: z.coerce
    .number({ message: "YGGDRASIL_MEMORY_MAX_BYTES must be a number" })
    .int()
    .nonnegative()
    .optional(),
  /**
   * cgroup soft memory limit (MemoryHigh). At this threshold the kernel begins
   * reclaiming memory from the cgroup (slowdown, not a kill). Auto-computed to 60%
   * of system RAM; overridable here.
   */
  YGGDRASIL_MEMORY_HIGH_BYTES: z.coerce
    .number({ message: "YGGDRASIL_MEMORY_HIGH_BYTES must be a number" })
    .int()
    .nonnegative()
    .optional(),
  /**
   * Kernel OOM-killer score adjustment for the service process. -1000 means the
   * OOM killer will never target this process (systemd's cgroup MemoryMax is the
   * controlled safety net instead). Set lower (closer to 0) to make the process
   * more expendable under system-wide pressure.
   */
  YGGDRASIL_OOM_SCORE_ADJUST: z.coerce
    .number({ message: "YGGDRASIL_OOM_SCORE_ADJUST must be a number" })
    .int()
    .min(-1000)
    .max(1000)
    .default(-1000),
  /** Maximum number of tasks (threads+processes) the cgroup may spawn. */
  YGGDRASIL_TASKS_MAX: z.coerce
    .number({ message: "YGGDRASIL_TASKS_MAX must be a number" })
    .int()
    .positive()
    .default(512),
  /**
   * Proactive memory release threshold. When available system memory drops below
   * this value (in MB), the application-level monitor releases ONNX sessions
   * before the cgroup OOM killer or kernel OOM killer has a chance to act.
   * Default: 256 MB.
   */
  YGGDRASIL_MEMORY_PRESSURE_THRESHOLD_MB: z.coerce
    .number({ message: "YGGDRASIL_MEMORY_PRESSURE_THRESHOLD_MB must be a number" })
    .int()
    .positive()
    .default(256),
  /**
   * Node.js V8 old-space size ceiling (MB) passed via --max-old-space-size at
   * process start. Limits JS heap growth so the process never silently balloons.
   * Default: auto-computed to 60% of system RAM at install time, min 1024, max 8192.
   */
  YGGDRASIL_NODE_MAX_OLD_SPACE_MB: z.coerce
    .number({ message: "YGGDRASIL_NODE_MAX_OLD_SPACE_MB must be a number" })
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

  // Reranker (ONNX cross-encoder — lazy-loaded on-demand)
  RERANKER_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /**
   * Absolute path to an ONNX reranker model. Must be set explicitly by the user.
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

  /** Reranker provider kind: "onnx" (local) or "openai-compatible" (remote endpoint). Defaults to "onnx". */
  RERANKER_PROVIDER: z.enum(["onnx", "openai-compatible"]).default("onnx"),
  /** Remote reranker endpoint base URL (provider === "openai-compatible"). */
  RERANKER_REMOTE_URL: z.string().optional(),
  /** Remote reranker model name (provider === "openai-compatible"). */
  RERANKER_MODEL_ID: z.string().optional(),

  // Memory search retrieval tuning
  /**
   * RRF k parameter for FTS5 (BM25) channel. Smaller values penalize
   * lower-ranked keyword hits more aggressively, making FTS matches more
   * discriminating when no reranker is available.
   * Default: 20 (more aggressive than the vector channel's 60).
   */
  MEMORY_SEARCH_RRF_K_FTS: z.coerce
    .number({ message: "MEMORY_SEARCH_RRF_K_FTS must be a number" })
    .int()
    .positive()
    .default(20),
  /**
   * RRF k parameter for vector similarity channel. Larger values give a
   * smoother distribution that rewards semantic recall.
   * Default: 60 (standard RRF).
   */
  MEMORY_SEARCH_RRF_K_VEC: z.coerce
    .number({ message: "MEMORY_SEARCH_RRF_K_VEC must be a number" })
    .int()
    .positive()
    .default(60),
  /**
   * Weight multiplier for FTS RRF contribution. Set >1.0 to boost keyword
   * matches when operating without a reranker.
   * Default: 1.3
   */
  MEMORY_SEARCH_RRF_FTS_WEIGHT: z.coerce
    .number({ message: "MEMORY_SEARCH_RRF_FTS_WEIGHT must be a number" })
    .positive()
    .default(1.3),
  /**
   * Weight multiplier for vector RRF contribution. Set >1.0 to boost
   * semantic matches when embeddings are available.
   * Default: 1.0
   */
  MEMORY_SEARCH_RRF_VEC_WEIGHT: z.coerce
    .number({ message: "MEMORY_SEARCH_RRF_VEC_WEIGHT must be a number" })
    .positive()
    .default(1.0),
  /**
   * Blend factor for BM25 score normalization (α). Higher values give BM25
   * score more influence on the final RRF ranking. Set to 0 to disable
   * BM25 score blending entirely. Default: 0.2 (subtle boost for strong matches).
   */
  MEMORY_SEARCH_BM25_BLEND: z.coerce
    .number({ message: "MEMORY_SEARCH_BM25_BLEND must be a number" })
    .min(0)
    .max(1)
    .default(0.2),
  /**
   * Importance boost factor (β). Higher values make high-importance memories
   * float more. Set to 0 to disable. Default: 0.2 (modest boost).
   */
  MEMORY_SEARCH_IMPORTANCE_BOOST: z.coerce
    .number({ message: "MEMORY_SEARCH_IMPORTANCE_BOOST must be a number" })
    .min(0)
    .max(2)
    .default(0.2),
  /**
   * NEAR window for multi-word FTS queries (in tokens). When > 0, adds a NEAR/N
   * query alongside the bag-of-words query to capture documents where query
   * terms appear close together (improves precision for keyword-only search).
   * Set to 0 to disable. Default: 5.
   */
  MEMORY_SEARCH_NEAR_WINDOW: z.coerce
    .number({ message: "MEMORY_SEARCH_NEAR_WINDOW must be a number" })
    .int()
    .min(0)
    .default(5),

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

  /**
   * Comma-separated ONNX execution-provider preference order, e.g.
   * "coreml,cpu". Overrides the platform default ladder resolved by
   * `resolveDefaultExecutionProviders()`.
   */
  ONNX_EXECUTION_PROVIDERS: z.string().optional(),

  // Experimental Web Provider Feature Flag & Security Limits (Spec §11.2)
  YGGDRASIL_ENABLE_EXPERIMENTAL_WEB_PROVIDERS: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  YGGDRASIL_WEB_PROVIDER_MAX_TOKEN_CHARS: z.coerce.number().int().positive().default(8192),
  YGGDRASIL_WEB_PROVIDER_MAX_USER_AGENT_CHARS: z.coerce.number().int().positive().default(1024),
  YGGDRASIL_WEB_PROVIDER_MAX_BODY_BYTES: z.coerce.number().int().positive().default(16384),
  YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_PER_IP: z.coerce.number().int().positive().default(5),
  YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_PER_CREDENTIAL: z.coerce.number().int().positive().default(10),
  YGGDRASIL_WEB_PROVIDER_CHECK_ATTEMPTS_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  YGGDRASIL_WEB_PROVIDER_CHECK_COOLDOWN_MS: z.coerce.number().int().positive().default(900000),
  YGGDRASIL_WEB_PROVIDER_CHECK_MAX_CONCURRENT: z.coerce.number().int().positive().default(3),
  YGGDRASIL_WEB_PROVIDER_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  YGGDRASIL_WEB_PROVIDER_ROUTE_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  YGGDRASIL_WEB_PROVIDER_RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(250),
  YGGDRASIL_WEB_PROVIDER_RETRY_BUDGET_MS: z.coerce.number().int().positive().default(15000),
  YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_MAX_SECONDS: z.coerce.number().int().positive().default(900),
  YGGDRASIL_WEB_PROVIDER_RETRY_AFTER_FALLBACK_SECONDS: z.coerce.number().int().positive().default(60),
  YGGDRASIL_WEB_PROVIDER_DISCOVERY_TTL_MS: z.coerce.number().int().positive().default(900000),
  YGGDRASIL_WEB_PROVIDER_DISCOVERY_REFRESH_COOLDOWN_MS: z.coerce.number().int().positive().default(30000),
  YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_STALE_MS: z.coerce.number().int().positive().default(86400000),
  YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_CACHE_ENTRIES: z.coerce.number().int().positive().default(100),
  YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_MODELS: z.coerce.number().int().positive().default(200),
  YGGDRASIL_WEB_PROVIDER_DISCOVERY_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(1048576),
  YGGDRASIL_WEB_PROVIDER_STREAM_FRAME_MAX_BYTES: z.coerce.number().int().positive().default(262144),
  YGGDRASIL_WEB_PROVIDER_STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  YGGDRASIL_WEB_PROVIDER_PROTOCOL_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  YGGDRASIL_WEB_PROVIDER_PROTOCOL_FAILURE_WINDOW_MS: z.coerce.number().int().positive().default(900000),

  // Security (Rule 04 / Rule 06: AES-256-GCM data-at-rest encryption secret)
  APP_SECRET: z
    .string()
    .min(32, "APP_SECRET must be at least 32 characters long")
    .optional()
    .or(z.literal("").transform(() => undefined)),
}).superRefine((data, ctx) => {
  if (
    data.NODE_ENV === "production" &&
    !data.APP_SECRET &&
    !data.VITEST &&
    data.NEXT_PHASE !== "phase-production-build"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "APP_SECRET is required in production and must be at least 32 characters. " +
        "It is generated automatically by `yggdrasil install` into ~/.yggdrasil/.env. " +
        "If you started the server manually, run `yggdrasil install` (or set APP_SECRET " +
        "from ~/.yggdrasil/.env) before launching.",
      path: ["APP_SECRET"],
    });
  }
});

/** Parsed environment, as produced by `env` / `refreshEnv`. */
export type AppEnv = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);

/**
 * Re-parses the schema from the current process.env. Call this when
 * environment values may have changed at runtime (e.g. provider API keys
 * rotated via the admin UI) and module-load-time values are stale.
 */
export function refreshEnv(): AppEnv {
  return envSchema.parse(process.env);
}
