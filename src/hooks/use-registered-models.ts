"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getProviders,
  hydrateSettings,
  PROVIDERS_CHANGED_EVENT,
  type ProviderKind,
} from "@/lib/settings";
import type { ModelEntry } from "@/lib/ai/provider-config/schema";

export type RegisteredModelGroup = {
  providerId: string;
  providerName: string;
  kind: ProviderKind;
  models: ModelEntry[];
};

export function useRegisteredModels(): {
  groups: RegisteredModelGroup[];
  loading: boolean;
  refresh: () => void;
} {
  const [groups, setGroups] = useState<RegisteredModelGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await hydrateSettings();
      const providers = getProviders();
      const loaded: RegisteredModelGroup[] = providers.map((p) => ({
        providerId: p.id,
        providerName: p.name,
        kind: p.kind,
        models: p.models,
      }));
      if (cancelled) return;
      setGroups(loaded);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [tick]);

  // Refetch whenever the provider registry is saved.
  useEffect(() => {
    const onChanged = () => refresh();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, onChanged);
    return () =>
      window.removeEventListener(PROVIDERS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  return { groups, loading, refresh };
}
