"use client";

import { useEffect, useRef, useState } from "react";
import {
  getEmbeddingSettings,
  getProviders,
  saveEmbeddingSettings,
} from "@/lib/settings";
import type { EmbeddingSource } from "@/components/settings/tabs";
import type { SettingsSnapshot } from "@/components/settings/snapshot";

/**
 * Embedding-tab state and handlers, owned by the settings shell.
 *
 * The state lives in the shell (not in `EmbeddingTab`) because Radix unmounts
 * inactive tab panels — moving it into the panel would discard unsaved edits on
 * every tab switch. See
 * `docs/adr/2026-11-03-settings-view-tab-state-hooks.md`.
 *
 * Hydration mirrors the shell's previous behavior exactly: the snapshot wins,
 * and it is re-applied whenever a new snapshot object is fetched (every
 * `settingsVersion` bump while the dialog is open). A failed re-fetch leaves
 * the form untouched, as before.
 */
export function useEmbeddingSettings({
  snapshot,
  onRefresh,
  onMaintenanceNote,
}: {
  /** The latest `GET /api/settings` snapshot, or null before the first load. */
  snapshot: SettingsSnapshot | null;
  /** Bump the shell's snapshot version so status badges re-read. */
  onRefresh: () => void;
  /** Surface a rebuild outcome in the Database tab's maintenance note. */
  onMaintenanceNote: (note: string) => void;
}) {
  // ---- Embedding source (used by the memory system) ----
  // Remote endpoints are always OpenAI-compatible; the legacy providerId /
  // `provider: "ollama"` forms remain resolvable server-side but are no
  // longer exposed as a provider dropdown. The key is write-only: non-empty
  // stores it, empty leaves it, "clear" removes it.
  const [embSource, setEmbSource] = useState<EmbeddingSource>(() => {
    const stored = getEmbeddingSettings();
    return stored.provider === "onnx" ? "onnx" : "remote";
  });
  const [embBaseUrl, setEmbBaseUrl] = useState(
    () => getEmbeddingSettings().baseUrl ?? ""
  );
  const [embLegacyProviderName, setEmbLegacyProviderName] = useState<
    string | null
  >(() => {
    const id = getEmbeddingSettings().providerId;
    if (!id) return null;
    return getProviders().find((provider) => provider.id === id)?.name ?? id;
  });
  // A legacy standalone block using Ollama's native protocol. It keeps
  // working (and keeps using /api/embed) until the endpoint is edited.
  const [embLegacyOllamaUrl, setEmbLegacyOllamaUrl] = useState<string | null>(
    () => {
      const stored = getEmbeddingSettings();
      return !stored.providerId && stored.provider === "ollama"
        ? (stored.baseUrl ?? null)
        : null;
    }
  );
  const [embApiKey, setEmbApiKey] = useState("");
  const [embModel, setEmbModel] = useState(
    () => getEmbeddingSettings().model ?? ""
  );
  const [embDimensions, setEmbDimensions] = useState<number | null>(
    () => getEmbeddingSettings().dimensions ?? null
  );
  // Server-side flag (the key value never reaches the client).
  const [embApiKeyConfigured, setEmbApiKeyConfigured] = useState(false);
  const clearEmbApiKey = () => {
    // Marked locally; the actual clear rides the next save.
    setEmbClearKey(true);
  };
  const [embClearKey, setEmbClearKey] = useState(false);
  const [embeddingSaved, setEmbeddingSaved] = useState(false);
  const [embSaveError, setEmbSaveError] = useState<string | null>(null);
  const [embCanForceSave, setEmbCanForceSave] = useState(false);
  // Endpoint+model+key signature of the last successful probe. Saving
  // re-probes when this does not match the current form.
  const lastProbeKeyRef = useRef<string | null>(null);
  const [detectBusy, setDetectBusy] = useState(false);
  const [detectResult, setDetectResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  // ---- Local ONNX embedding provider ----
  // The model file is auto-discovered server-side; the user picks one.
  const [embOnnxModelPath, setEmbOnnxModelPath] = useState(
    () => getEmbeddingSettings().modelPath ?? ""
  );

  // ---- Embedding model-change confirmation ----
  const [modelChanged, setModelChanged] = useState<string | null>(null);
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [rebuildProgress, setRebuildProgress] = useState<{
    current: number;
    total: number;
    percent: number;
  }>({ current: 0, total: 0, percent: 0 });
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const loadedEmbeddingModelRef = useRef<string | null>(null);

  // Re-sync the embedding block from the database snapshot.
  // The embedding block moved out of the legacy store: GET serves it
  // top-level (the redacted registry view). providerId set → a registry
  // provider supplies the endpoint; null → standalone.
  useEffect(() => {
    if (!snapshot) return;
    const emb = snapshot.embedding;
    if (emb !== null) {
      if (typeof emb.providerId === "string") {
        // A registry provider is authoritative even if a stale legacy
        // `provider: "onnx"` discriminator remains on the block. It is
        // shown as a direct endpoint so the next save can drop the
        // provider reference; the endpoint is prefilled from the provider.
        const providerList = Array.isArray(snapshot.store?.providers)
          ? snapshot.store.providers
          : [];
        const legacyProvider = providerList.find(
          (p) => p.id === emb.providerId
        );
        setEmbSource("remote");
        setEmbLegacyProviderName(
          legacyProvider?.name ?? (emb.providerId as string)
        );
        setEmbLegacyOllamaUrl(null);
        setEmbBaseUrl(legacyProvider?.baseUrl ?? "");
        setEmbOnnxModelPath("");
      } else if (emb.provider === "onnx") {
        // Local ONNX model: a discovered/selected file.
        setEmbSource("onnx");
        setEmbLegacyProviderName(null);
        setEmbLegacyOllamaUrl(null);
        setEmbOnnxModelPath(
          typeof emb.modelPath === "string" ? emb.modelPath : ""
        );
      } else {
        setEmbSource("remote");
        setEmbLegacyProviderName(null);
        setEmbLegacyOllamaUrl(
          emb.provider === "ollama" && typeof emb.baseUrl === "string"
            ? emb.baseUrl
            : null
        );
        setEmbBaseUrl(typeof emb.baseUrl === "string" ? emb.baseUrl : "");
      }
      setEmbModel(typeof emb.model === "string" ? emb.model : "");
      setEmbApiKeyConfigured(Boolean(emb.apiKeyConfigured));
      setEmbDimensions(
        typeof emb.dimensions === "number" ? emb.dimensions : null
      );
      const currentKey = emb.provider === "onnx"
        ? (typeof emb.modelPath === "string" && emb.modelPath ? `onnx:${emb.modelPath}` : "onnx:default")
        : (typeof emb.model === "string" && emb.model ? emb.model : "default");
      loadedEmbeddingModelRef.current = currentKey;
    }
    // Check if the server flagged an embedding model change.
    if (snapshot.embeddingModelChanged) {
      setModelChanged(snapshot.embeddingModelChanged);
    }
  }, [snapshot]);

  async function handleRebuildEmbeddings() {
    setRebuildBusy(true);
    setRebuildError(null);
    setRebuildProgress({ current: 0, total: 0, percent: 0 });

    try {
      const res = await fetch("/api/maintenance/rebuild-index?stream=true", {
        method: "POST",
        headers: { Accept: "text/event-stream" },
      });
      if (!res.ok) throw new Error(String(res.status));

      const contentType = res.headers.get("content-type") || "";

      if (contentType.includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let lastResult: {
          nulledCount?: number;
          embeddedCount?: number;
          remaining?: number;
        } | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            try {
              const data = JSON.parse(trimmed.slice(5).trim());
              if (data.type === "progress") {
                const current = Number(data.current || 0);
                const total = Number(data.total || 0);
                const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
                setRebuildProgress({ current, total, percent });
              } else if (data.type === "complete") {
                lastResult = data;
                setRebuildProgress((prev) => ({
                  current: data.embeddedCount ?? prev.current,
                  total: data.nulledCount ?? prev.total,
                  percent: data.remaining == null || data.remaining === 0 ? 100 : Math.min(99, prev.percent),
                }));
              } else if (data.type === "error") {
                throw new Error(data.error || "Embedding index rebuild failed");
              }
            } catch (parseErr) {
              if (
                parseErr instanceof Error &&
                parseErr.message !== "Embedding index rebuild failed"
              ) {
                // ignore malformed SSE line
              } else {
                throw parseErr;
              }
            }
          }
        }

        onMaintenanceNote(
          `Rebuilt index: re-embedded ${lastResult?.embeddedCount ?? 0} memories (${lastResult?.nulledCount ?? 0} vectors replaced). ${lastResult?.remaining ?? 0} pending.`
        );
        if (lastResult?.remaining == null || lastResult.remaining === 0) setModelChanged(null);
        onRefresh();
      } else {
        const data = (await res.json()) as {
          nulledCount?: number;
          embeddedCount?: number;
          remaining?: number;
        };
        setRebuildProgress({
          current: data.embeddedCount ?? 0,
          total: data.nulledCount ?? data.embeddedCount ?? 0,
          percent: data.remaining == null || data.remaining === 0 ? 100 : 0,
        });
        onMaintenanceNote(
          `Rebuilt index: re-embedded ${data.embeddedCount ?? 0} memories (${data.nulledCount ?? 0} vectors replaced). ${data.remaining ?? 0} pending.`
        );
        if (data.remaining == null || data.remaining === 0) setModelChanged(null);
        onRefresh();
      }
    } catch (error) {
      console.error(
        "[settings] Embedding index rebuild failed:",
        error instanceof Error ? error.message : String(error)
      );
      const msg = error instanceof Error ? error.message : "Embedding index rebuild failed";
      setRebuildError(msg);
      onMaintenanceNote("Embedding index rebuild failed.");
    } finally {
      setRebuildBusy(false);
    }
  }

  async function dismissModelChange() {
    try {
      const res = await fetch("/api/maintenance/dismiss-model-change", {
        method: "POST",
      });
      if (!res.ok) {
        console.error(
          "[settings] Dismiss model-change request failed:",
          res.status
        );
      }
    } catch (error) {
      console.error(
        "[settings] Dismiss model-change network error:",
        error instanceof Error ? error.message : String(error)
      );
    }
    setModelChanged(null);
  }

  // Remote endpoints speak the OpenAI-compatible protocol by default. A
  // legacy standalone Ollama block keeps its native /api/embed protocol
  // until the user edits the base URL.
  const useLegacyOllamaProtocol =
    embSource === "remote" &&
    embLegacyOllamaUrl !== null &&
    embBaseUrl.trim() === embLegacyOllamaUrl;

  // Signature of the current probe inputs. Saving re-probes whenever this
  // does not match the last successful probe, so a stale dimension can never
  // be saved and a broken endpoint cannot be switched in silently.
  const embeddingProbeKey =
    embSource === "onnx"
      ? `onnx:${embOnnxModelPath.trim() || "default"}`
      : `${useLegacyOllamaProtocol ? "ollama" : "openai-compatible"}:${embBaseUrl.trim()}|${embModel.trim()}|${
          embApiKey.trim() ? "typed-key" : "stored-key"
        }`;

  const runEmbeddingProbe = async (): Promise<{
    ok: boolean;
    dimensions?: number;
    text: string;
  }> => {
    try {
      const res = await fetch("/api/embeddings/detect", {
        body: JSON.stringify(
          embSource === "onnx"
            ? {
                provider: "onnx",
                modelPath: embOnnxModelPath.trim() || undefined,
              }
            : {
                provider: useLegacyOllamaProtocol
                  ? "ollama"
                  : "openai-compatible",
                baseUrl: embBaseUrl.trim() || undefined,
                apiKey: embApiKey.trim() || undefined,
                model: embModel.trim() || undefined,
              }
        ),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await res.json()) as {
        dimensions?: number;
        model?: string;
        latencyMs?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (typeof data.dimensions !== "number") {
        throw new Error("The endpoint returned no vector dimensions.");
      }
      return {
        ok: true,
        dimensions: data.dimensions,
        text: `${data.dimensions} dimensions · ${data.model} · ${data.latencyMs ?? 0} ms`,
      };
    } catch (error) {
      return {
        ok: false,
        text:
          error instanceof Error
            ? error.message
            : "The connection test failed.",
      };
    }
  };

  const saveEmbedding = async (force = false) => {
    setEmbSaveError(null);
    setEmbCanForceSave(false);

    // Probe before persisting so the stored dimension belongs to the model
    // that is actually being saved. `force` skips the probe (offered by the
    // "Save without testing" fallback after a failure).
    let detectedDimensions = embDimensions ?? undefined;
    if (force) {
      // Never attach the previous model's dimension to a different model
      // when the probe could not verify it.
      const currentModelKey = embSource === "onnx"
        ? (embOnnxModelPath.trim() ? `onnx:${embOnnxModelPath.trim()}` : "onnx:default")
        : (embModel.trim() || "default");
      if (
        loadedEmbeddingModelRef.current &&
        loadedEmbeddingModelRef.current !== currentModelKey
      ) {
        detectedDimensions = undefined;
      }
    }
    if (!force && lastProbeKeyRef.current !== embeddingProbeKey) {
      setDetectBusy(true);
      setDetectResult(null);
      const probe = await runEmbeddingProbe();
      setDetectBusy(false);
      setDetectResult({ ok: probe.ok, text: probe.text });
      if (!probe.ok) {
        setEmbCanForceSave(true);
        setEmbSaveError(
          `${probe.text} Fix the settings above, or save without testing to keep the previous vectors until the endpoint works.`
        );
        return;
      }
      detectedDimensions = probe.dimensions ?? detectedDimensions;
      if (probe.dimensions) setEmbDimensions(probe.dimensions);
      lastProbeKeyRef.current = embeddingProbeKey;
    }

    try {
      let res: { embeddingModelChanged?: string | null } | undefined;
      if (embSource === "onnx") {
        res = await saveEmbeddingSettings({
          provider: "onnx",
          providerId: null,
          modelPath: embOnnxModelPath.trim() || undefined,
          dimensions: detectedDimensions,
          chunkSize: 2000,
          chunkOverlap: 200,
        });
      } else {
        res = await saveEmbeddingSettings({
          // Always standalone: no provider reference, endpoint + key live on
          // the embedding block itself.
          providerId: null,
          provider: useLegacyOllamaProtocol ? "ollama" : "openai-compatible",
          modelPath: undefined,
          poolingMode: undefined,
          baseUrl: embBaseUrl.trim() || undefined,
          ...(embApiKey.trim() ? { apiKey: embApiKey.trim() } : {}),
          ...(embClearKey ? { clearApiKey: true } : {}),
          model: embModel.trim() || undefined,
          dimensions: detectedDimensions,
          chunkSize: 2000,
          chunkOverlap: 200,
        });
      }
      setEmbApiKey("");
      setEmbClearKey(false);
      if (embClearKey) setEmbApiKeyConfigured(false);
      else if (embApiKey.trim()) setEmbApiKeyConfigured(true);
      setEmbLegacyProviderName(null);
      setEmbLegacyOllamaUrl(
        embSource === "remote" && useLegacyOllamaProtocol
          ? embBaseUrl.trim()
          : null
      );
      setEmbeddingSaved(true);
      window.setTimeout(() => setEmbeddingSaved(false), 2000);
      onRefresh();

      // Trigger rebuild index warning popup when embedding model changed
      const currentModelKey = embSource === "onnx"
        ? (embOnnxModelPath.trim() ? `onnx:${embOnnxModelPath.trim()}` : "onnx:default")
        : (embModel.trim() || "default");

      if (res?.embeddingModelChanged) {
        setModelChanged(res.embeddingModelChanged);
      } else if (
        loadedEmbeddingModelRef.current &&
        loadedEmbeddingModelRef.current !== currentModelKey
      ) {
        setModelChanged(currentModelKey);
      }
      loadedEmbeddingModelRef.current = currentModelKey;
    } catch (error) {
      setEmbSaveError(
        error instanceof Error ? error.message : "Failed to save settings"
      );
    }
  };

  // Probe the configured endpoint and store the model's native vector
  // dimension.
  const detectDimensions = async () => {
    setDetectBusy(true);
    setDetectResult(null);
    const result = await runEmbeddingProbe();
    if (result.ok && result.dimensions) {
      setEmbDimensions(result.dimensions);
      lastProbeKeyRef.current = embeddingProbeKey;
    }
    setDetectResult({ ok: result.ok, text: result.text });
    setDetectBusy(false);
  };

  return {
    embSource,
    setEmbSource,
    embBaseUrl,
    setEmbBaseUrl,
    embLegacyProviderName,
    embApiKey,
    setEmbApiKey,
    embModel,
    setEmbModel,
    embDimensions,
    setEmbDimensions,
    embApiKeyConfigured,
    clearEmbApiKey,
    embClearKey,
    setEmbClearKey,
    embeddingSaved,
    embSaveError,
    embCanForceSave,
    detectBusy,
    detectResult,
    setDetectResult,
    embOnnxModelPath,
    setEmbOnnxModelPath,
    modelChanged,
    rebuildBusy,
    rebuildProgress,
    rebuildError,
    handleRebuildEmbeddings,
    dismissModelChange,
    saveEmbedding,
    detectDimensions,
  };
}
