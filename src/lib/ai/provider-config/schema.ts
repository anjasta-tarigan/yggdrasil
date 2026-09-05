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

export const ProviderEntrySchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9][a-z0-9-_]*$/i),
  kind: z.enum(["openai-compatible", "ollama"]),
  name: z.string().trim().min(1).max(128),
  baseUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u))
    .max(2048),
  apiKeyEnv: z.string().regex(/^PROVIDER_[A-Z0-9_]+_API_KEY$/).optional(),
  source: z.enum(["env"]).optional(),
  models: z.array(ModelEntrySchema).max(200).default([]),
});

export const EmbeddingBlockSchema = z
  .object({
    providerId: z.string().nullable(),
    baseUrl: z.string().url().max(2048).optional(),
    apiKeyEnv: z.string().regex(/^PROVIDER_[A-Z0-9_]+_API_KEY$/).optional(),
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

export type ProviderEntryView = Omit<ProviderEntry, "apiKeyEnv"> & {
  apiKeyEnv?: string;
  apiKeyConfigured: boolean;
};
