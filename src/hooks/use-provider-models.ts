"use client";

import { useRegisteredModels, type RegisteredModelGroup } from "./use-registered-models";
import type { ModelInfo } from "@/lib/ai/models";

export type { ModelInfo };

/**
 * Legacy provider group shape for backward compatibility.
 * @deprecated Use `RegisteredModelGroup` from `use-registered-models` instead.
 */
export type ProviderModelGroup = {
  error: boolean;
  kind: "server" | RegisteredModelGroup["kind"];
  models: ModelInfo[];
  providerId: string;
  providerName: string;
};

/**
 * Model lists for every active provider.
 * @deprecated Use `useRegisteredModels` instead.
 */
export function useProviderModels(): {
  groups: ProviderModelGroup[];
  loading: boolean;
  refresh: () => void;
} {
  const { groups: registeredGroups, loading, refresh } = useRegisteredModels();

  const groups: ProviderModelGroup[] = registeredGroups.map((g) => ({
    error: false,
    kind: g.kind,
    providerId: g.providerId,
    providerName: g.providerName,
    models: g.models.map((m) => ({
      id: m.modelId,
      contextLength: m.capabilities?.contextWindow ?? null,
      maxOutputTokens: m.capabilities?.maxOutputTokens ?? null,
    })),
  }));

  return { groups, loading, refresh };
}
