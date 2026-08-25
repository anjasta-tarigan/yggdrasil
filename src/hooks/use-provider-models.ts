"use client";

import { useCallback, useEffect, useState } from "react";
import type { ModelInfo } from "@/lib/ai/models";
import {
  getProviders,
  SERVER_PROVIDER_ID,
  type ProviderConfig,
} from "@/lib/settings";

export type { ModelInfo };

/** One provider group for the model selector's tree view. */
export type ProviderModelGroup = {
  /** Fetch failed for this provider (selector shows a hint). */
  error: boolean;
  kind: "server" | ProviderConfig["kind"];
  models: ModelInfo[];
  providerId: string;
  providerName: string;
};

function parseServerModels(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const parsed: ModelInfo[] = [];
  for (const entry of raw) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === "string"
    ) {
      const m = entry as Record<string, unknown>;
      parsed.push({
        id: m.id as string,
        contextLength:
          typeof m.contextLength === "number" ? m.contextLength : null,
        maxOutputTokens:
          typeof m.maxOutputTokens === "number" ? m.maxOutputTokens : null,
      });
    }
  }
  return parsed;
}

async function loadServerGroup(): Promise<ProviderModelGroup> {
  try {
    const res = await fetch("/api/models", { cache: "no-store" });
    const data = (await res.json()) as { models?: unknown };
    return {
      error: false,
      kind: "server",
      models: parseServerModels(data.models),
      providerId: SERVER_PROVIDER_ID,
      providerName: "This server",
    };
  } catch {
    return {
      error: true,
      kind: "server",
      models: [],
      providerId: SERVER_PROVIDER_ID,
      providerName: "This server",
    };
  }
}

async function loadProviderGroup(
  provider: ProviderConfig
): Promise<ProviderModelGroup> {
  try {
    const res = await fetch("/api/providers/models", {
      body: JSON.stringify({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        kind: provider.kind,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { models?: Array<{ id?: string }> };
    const models: ModelInfo[] = (data.models ?? [])
      .filter((m) => typeof m.id === "string" && m.id)
      .map((m) => ({
        contextLength: null,
        id: m.id as string,
        maxOutputTokens: null,
      }));
    return {
      error: false,
      kind: provider.kind,
      models,
      providerId: provider.id,
      providerName: provider.name,
    };
  } catch {
    return {
      error: true,
      kind: provider.kind,
      models: [],
      providerId: provider.id,
      providerName: provider.name,
    };
  }
}

/**
 * Model lists for every active provider: the built-in server provider
 * plus all user-added providers from the settings registry. Refetches
 * when the registry changes (saveProviders dispatches the event).
 */
export function useProviderModels(): {
  groups: ProviderModelGroup[];
  loading: boolean;
  refresh: () => void;
} {
  const [groups, setGroups] = useState<ProviderModelGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    // No synchronous setState here (React Compiler rule): `loading` starts
    // true and flips once on completion; refreshes keep showing the
    // previous groups until the new ones arrive.

    const providers = getProviders();
    void Promise.all([
      loadServerGroup(),
      ...providers.map(loadProviderGroup),
    ]).then((loaded) => {
      if (cancelled) return;
      setGroups(loaded);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [tick]);

  // Refetch whenever the provider registry is saved (settings view).
  useEffect(() => {
    const onChanged = () => refresh();
    window.addEventListener("yggdrasil:providers-changed", onChanged);
    return () =>
      window.removeEventListener("yggdrasil:providers-changed", onChanged);
  }, [refresh]);

  return { groups, loading, refresh };
}
