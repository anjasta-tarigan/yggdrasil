import { z } from "zod";

export const ModalitySchema = z.enum(["text", "image", "audio", "video", "pdf"]);

export const CapabilitySourceSchema = z.enum([
  "models.dev",
  "provider-metadata",
  "live-probe",
  "user",
]);

export const CapabilitiesSchema = z.object({
  contextWindow: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  inputModalities: z.array(ModalitySchema).min(1),
  outputModalities: z.array(ModalitySchema).min(1),
  supportsToolCalls: z.boolean().nullable(),
  supportsReasoning: z.boolean().nullable(),
});

export const CapabilitySourcesSchema = z.record(
  z.string(),
  CapabilitySourceSchema,
);

export const ModelEntrySchema = z.object({
  modelId: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
  isDefault: z.boolean().default(false),
  capabilities: CapabilitiesSchema,
  capabilitySources: CapabilitySourcesSchema.default({}),
});

export const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const ProviderIdSchema = z.string().trim().min(1).max(128).regex(/^[a-z0-9][a-z0-9-_]*$/i);
export const ApiKeyRefSchema = z.object({
  id: ProviderIdSchema,
  apiKeyEnv: z.string().regex(/^PROVIDER_[A-Z0-9_]+_API_KEY$/),
});

export const ProviderEntrySchema = z.object({
  id: ProviderIdSchema,
  kind: z.enum(["openai-compatible", "ollama", "web-session"]),
  preset: z.enum(["nvidia-nim", "deepseek-web"]).optional(),
  apiKeys: z.array(ApiKeyRefSchema).min(1).max(20).optional(),
  name: z.string().trim().min(1).max(128),
  baseUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u))
    .max(2048),
  apiKeyEnv: z.string().regex(/^PROVIDER_[A-Z0-9_]+_API_KEY$/).optional(),
  source: z.enum(["env"]).optional(),
  models: z.array(ModelEntrySchema).max(200).default([]),
}).superRefine((entry, ctx) => {
  if (entry.apiKeys && entry.apiKeyEnv) {
    ctx.addIssue({ code: "custom", path: ["apiKeys"], message: "Use either apiKeys or apiKeyEnv, not both" });
  }
  if (entry.apiKeys && new Set(entry.apiKeys.map(row => row.id)).size !== entry.apiKeys.length) {
    ctx.addIssue({ code: "custom", path: ["apiKeys"], message: "Duplicate API key id" });
  }
  if (entry.preset === "nvidia-nim") {
    if (entry.kind !== "openai-compatible" || entry.baseUrl !== NIM_BASE_URL) {
      ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "NIM requires openai-compatible and the fixed NVIDIA endpoint" });
    }
    if (!entry.apiKeys?.length) {
      ctx.addIssue({ code: "custom", path: ["apiKeys"], message: "NIM requires at least one API key" });
    }
  }
  // DeepSeek Web is a browser-session adapter: it must not masquerade as a
  // key-based provider, so its kind is pinned to web-session.
  if (entry.preset === "deepseek-web" && entry.kind !== "web-session") {
    ctx.addIssue({ code: "custom", path: ["kind"], message: "DeepSeek Web requires kind web-session" });
  }
});

export const EmbeddingBlockSchema = z
  .object({
    // Kind discriminator. Absent blocks resolve by providerId/baseUrl (legacy
    // behaviour); "onnx" selects the local ONNX model path. Other kinds are
    // accepted for forward-compat but ignored by resolution.
    provider: z.enum(["server", "openai-compatible", "ollama", "onnx"]).optional(),
    providerId: z.string().nullable(),
    baseUrl: z.string().url().max(2048).optional(),
    apiKeyEnv: z.string().regex(/^PROVIDER_[A-Z0-9_]+_API_KEY$/).optional(),
    /** ONNX model file (absolute path or filename in data/models/embedding/). */
    modelPath: z.string().max(2048).optional(),
    /**
     * Pooling for a token-level ONNX output. Absent = auto-resolve from the
     * model's 1_Pooling/config.json; set only when that is missing.
     */
    poolingMode: z.enum(["mean", "cls", "lasttoken", "max"]).optional(),
    model: z.string().max(200).optional(),
    dimensions: z.number().int().positive().max(32768).optional(),
    chunkSize: z.number().int().min(200).max(20000).optional(),
    chunkOverlap: z.number().int().min(0).max(10000).optional(),
  })
  .refine(
    (b) =>
      b.chunkOverlap == null ||
      b.chunkSize == null ||
      b.chunkOverlap <= Math.floor(b.chunkSize / 2),
    { message: "chunkOverlap must be at most half of chunkSize" },
  )
  .refine(
    (b) => {
      // onnx requires a modelPath; other providers use providerId or baseUrl.
      if (b.provider === "onnx") {
        return typeof b.modelPath === "string" && b.modelPath.length > 0;
      }
      return true;
    },
    { message: "embedding.provider 'onnx' requires a modelPath" },
  );

export const RegistryDocumentSchema = z
  .object({
    version: z.literal(1).default(1),
    providers: z.array(ProviderEntrySchema).max(50),
    embedding: EmbeddingBlockSchema.optional(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const providerIds = new Set<string>();

    // Unique provider ids.
    for (const provider of doc.providers) {
      if (providerIds.has(provider.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["providers"],
          message: `Duplicate provider id: ${provider.id}`,
        });
      }
      providerIds.add(provider.id);
    }

    // Unique modelIds within a provider.
    for (const provider of doc.providers) {
      const modelIds = new Set<string>();
      for (const model of provider.models) {
        if (modelIds.has(model.modelId)) {
          ctx.addIssue({
            code: "custom",
            path: ["providers"],
            message: `Duplicate modelId ${model.modelId} within provider ${provider.id}`,
          });
        }
        modelIds.add(model.modelId);
      }
    }

    // At most one isDefault:true model across ALL providers.
    const defaults = doc.providers.flatMap((p) =>
      p.models.filter((m) => m.isDefault),
    );
    if (defaults.length > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["providers"],
        message: "At most one model may have isDefault: true",
      });
    }

    // embedding.providerId (when non-null) must reference an existing provider id.
    if (
      doc.embedding?.providerId != null &&
      !providerIds.has(doc.embedding.providerId)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["embedding", "providerId"],
        message: `embedding.providerId references unknown provider: ${doc.embedding.providerId}`,
      });
    }
  });

export type Modality = z.infer<typeof ModalitySchema>;
export type CapabilitySource = z.infer<typeof CapabilitySourceSchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type CapabilitySources = z.infer<typeof CapabilitySourcesSchema>;
export type ModelEntry = z.infer<typeof ModelEntrySchema>;
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;
export type ProviderKind = ProviderEntry["kind"];
export type EmbeddingBlock = z.infer<typeof EmbeddingBlockSchema>;
export type RegistryDocument = z.infer<typeof RegistryDocumentSchema>;

export type ProviderEntryView = Omit<ProviderEntry, "apiKeys"> & {
  apiKeys?: Array<z.infer<typeof ApiKeyRefSchema> & { configured: boolean }>;
  apiKeyConfigured: boolean;
};
