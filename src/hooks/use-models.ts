"use client";

import { useEffect, useState } from "react";

/**
 * Fetches the model list from `/api/models` once on mount.
 * Returns the ids served by the OpenAI-compatible endpoint.
 */
export function useModels(): { models: string[]; loading: boolean } {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        const data = (await res.json()) as { models?: unknown };
        if (!cancelled && Array.isArray(data.models)) {
          setModels(data.models.filter((m): m is string => typeof m === "string"));
        }
      } catch {
        // Leave the list empty; the selector falls back to the default model.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  return { models, loading };
}
