"use client";

import { useEffect, useState } from "react";
import type { ModelInfo } from "@/lib/ai/models";

export type { ModelInfo };

/**
 * Fetches the model list (ids + context-window limits) from `/api/models`
 * once on mount, so the UI can auto-size indicators to the selected model.
 */
export function useModels(): { models: ModelInfo[]; loading: boolean } {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        const data = (await res.json()) as { models?: unknown };
        if (!cancelled && Array.isArray(data.models)) {
          const parsed: ModelInfo[] = [];
          for (const entry of data.models) {
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
                  typeof m.maxOutputTokens === "number"
                    ? m.maxOutputTokens
                    : null,
              });
            }
          }
          setModels(parsed);
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
