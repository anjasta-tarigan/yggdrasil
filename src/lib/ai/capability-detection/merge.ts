import { Capabilities, CapabilitySources } from "@/lib/ai/provider-config/schema";

export type CapabilityLayers = {
  catalog?: Partial<Capabilities>;
  providerMeta?: Partial<Capabilities>;
  probes?: Partial<Capabilities>;
};

export type ExistingCapabilityContext =
  | {
      capabilities?: Partial<Capabilities>;
      capabilitySources?: CapabilitySources;
    }
  | CapabilitySources;

const CAPABILITY_KEYS: (keyof Capabilities)[] = [
  "contextWindow",
  "maxOutputTokens",
  "inputModalities",
  "outputModalities",
  "supportsToolCalls",
  "supportsReasoning",
];

/**
 * Merge capabilities across layers (catalog -> provider-metadata -> live-probes),
 * with strict preservation of user overrides (source: "user").
 */
export function mergeCapabilities(
  layers: CapabilityLayers,
  existing?: ExistingCapabilityContext
): {
  capabilities: Capabilities;
  capabilitySources: CapabilitySources;
} {
  // Normalize existing context
  let existingCaps: Partial<Capabilities> | undefined;
  let existingSources: CapabilitySources | undefined;

  if (existing) {
    if ("capabilitySources" in existing || "capabilities" in existing) {
      existingCaps = (existing as { capabilities?: Partial<Capabilities> }).capabilities;
      existingSources = (existing as { capabilitySources?: CapabilitySources }).capabilitySources;
    } else {
      existingSources = existing as CapabilitySources;
    }
  }

  // Base state
  const capabilities: Capabilities = {
    contextWindow: null,
    maxOutputTokens: null,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalls: null,
    supportsReasoning: null,
  };
  const capabilitySources: CapabilitySources = {};

  // 1. Apply catalog layer (source: "models.dev")
  if (layers.catalog) {
    for (const key of CAPABILITY_KEYS) {
      const val = layers.catalog[key];
      if (val !== undefined && val !== null) {
        (capabilities as any)[key] = val;
        capabilitySources[key] = "models.dev";
      }
    }
  }

  // 2. Apply providerMeta layer (source: "provider-metadata")
  // Overrides limits and fills available fields
  if (layers.providerMeta) {
    for (const key of CAPABILITY_KEYS) {
      const val = layers.providerMeta[key];
      if (val !== undefined && val !== null) {
        (capabilities as any)[key] = val;
        capabilitySources[key] = "provider-metadata";
      }
    }
  }

  // 3. Apply probes layer (source: "live-probe")
  // Only fills still-null modality booleans / values or modality arrays
  if (layers.probes) {
    for (const key of CAPABILITY_KEYS) {
      const val = layers.probes[key];
      if (val !== undefined && val !== null) {
        // Only apply if field is still default/unset
        if (
          (key === "inputModalities" && capabilitySources[key] === undefined) ||
          (key === "outputModalities" && capabilitySources[key] === undefined) ||
          ((capabilities as any)[key] === null && capabilitySources[key] === undefined) ||
          key === "inputModalities" ||
          key === "outputModalities"
        ) {
          (capabilities as any)[key] = val;
          capabilitySources[key] = "live-probe";
        }
      }
    }
  }

  // 4. PRESERVATION RULING: User overrides always win
  if (existingSources) {
    for (const key of CAPABILITY_KEYS) {
      if (existingSources[key] === "user") {
        if (existingCaps && existingCaps[key] !== undefined) {
          (capabilities as any)[key] = existingCaps[key];
        }
        capabilitySources[key] = "user";
      }
    }
  }

  return { capabilities, capabilitySources };
}
