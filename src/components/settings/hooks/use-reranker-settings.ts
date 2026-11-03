"use client";

import {
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  saveSettingsPatch,
  type SettingsSnapshot,
} from "@/components/settings/snapshot";

/**
 * Reranker-tab state and handlers, owned by the settings shell.
 *
 * The state lives in the shell (not in `RerankerTab`) because Radix unmounts
 * inactive tab panels — moving it into the panel would discard unsaved edits on
 * every tab switch. See
 * `docs/adr/2026-11-03-settings-view-tab-state-hooks.md`.
 *
 * Unlike the embedding form, the reranker auto-saves on every interaction, so
 * there is no `isDirty` participation. Hydration mirrors the shell's previous
 * behavior exactly: it runs only after a successful snapshot fetch, so a failed
 * re-fetch leaves the form untouched.
 */
export function useRerankerSettings({
  snapshot,
  onRefresh,
  setSnapshot,
}: {
  /** The latest `GET /api/settings` snapshot, or null before the first load. */
  snapshot: SettingsSnapshot | null;
  /** Bump the shell's snapshot version so status badges re-read. */
  onRefresh: () => void;
  /**
   * Patch the shell's snapshot copy. The enable toggle updates the status
   * optimistically (mode/loaded/available) and rolls back on failure.
   */
  setSnapshot: Dispatch<SetStateAction<SettingsSnapshot | null>>;
}) {
  // ---- Neural reranker (powers cross-encoder memory search) ----
  const [rerankerEnabled, setRerankerEnabled] = useState(true);
  const [rerankerSelectedModel, setRerankerSelectedModel] = useState("");
  const [rerankerProvider, setRerankerProvider] = useState<
    "onnx" | "openai-compatible"
  >("onnx");
  const [rerankerBaseUrl, setRerankerBaseUrl] = useState("");
  const [rerankerRemoteModel, setRerankerRemoteModel] = useState("");
  const [rerankerApiKeyEnv, setRerankerApiKeyEnv] = useState("");
  const [rerankerIdleTimeoutMinutes, setRerankerIdleTimeoutMinutes] =
    useState(15);
  const [rerankerSaved, setRerankerSaved] = useState(false);
  const [rerankerSaveError, setRerankerSaveError] = useState<string | null>(
    null
  );
  const [rerankerProbeBusy, setRerankerProbeBusy] = useState(false);
  const [rerankerProbeResult, setRerankerProbeResult] =
    useState<{ ok: boolean; text: string } | null>(null);
  const [rerankerSaving, setRerankerSaving] = useState(false);

  // Re-sync reranker configuration from status or stored settings.
  useEffect(() => {
    if (!snapshot) return;
    const data = snapshot;
    const storeReranker = data.store?.reranker as
      | {
          enabled?: boolean;
          provider?: string;
          baseUrl?: string;
          model?: string;
          apiKeyEnv?: string;
          selectedModel?: string;
          idleTimeoutMinutes?: number;
        }
      | undefined;
    if (data.reranker) {
      setRerankerEnabled(data.reranker.enabled);
    } else if (storeReranker && typeof storeReranker.enabled === "boolean") {
      setRerankerEnabled(storeReranker.enabled);
    }
    if (storeReranker && storeReranker.provider) {
      setRerankerProvider(
        storeReranker.provider as "onnx" | "openai-compatible"
      );
    } else {
      setRerankerProvider("onnx");
    }
    if (storeReranker && storeReranker.baseUrl) {
      setRerankerBaseUrl(storeReranker.baseUrl);
    }
    if (storeReranker && storeReranker.model) {
      setRerankerRemoteModel(storeReranker.model);
    }
    if (storeReranker && storeReranker.apiKeyEnv) {
      setRerankerApiKeyEnv(storeReranker.apiKeyEnv);
    }
    if (
      storeReranker &&
      typeof storeReranker.idleTimeoutMinutes === "number"
    ) {
      setRerankerIdleTimeoutMinutes(storeReranker.idleTimeoutMinutes);
    }
    if (storeReranker && storeReranker.selectedModel) {
      setRerankerSelectedModel(storeReranker.selectedModel);
    } else if (data.reranker?.modelPath) {
      const fullPath = data.reranker.modelPath;
      const matched = data.reranker.discoveredModels?.find(
        (m) =>
          fullPath === m.filename ||
          fullPath.endsWith("/" + m.filename) ||
          fullPath.endsWith("\\" + m.filename)
      );
      if (matched) {
        setRerankerSelectedModel(matched.filename);
      } else if (fullPath.includes("data/models/reranker/")) {
        setRerankerSelectedModel(
          fullPath.split("data/models/reranker/").pop() ?? ""
        );
      } else {
        const filename = fullPath.split(/[/\\]/).pop();
        if (filename) setRerankerSelectedModel(filename);
      }
    }
  }, [snapshot]);

  /**
   * Flip neural reranker toggle and persist immediately with optimistic
   * rollback on failure.
   */
  /**
   * Build the reranker settings patch from current local state.
   */
  const buildRerankerPatch = (overrides?: {
    enabled?: boolean;
    provider?: "onnx" | "openai-compatible";
    baseUrl?: string;
    remoteModel?: string;
    apiKeyEnv?: string;
    selectedModel?: string;
    idleTimeoutMinutes?: number;
  }) => {
    const provider = overrides?.provider ?? rerankerProvider;
    return {
      reranker: {
        enabled: overrides?.enabled ?? rerankerEnabled,
        provider,
        ...(provider === "onnx"
          ? {
              selectedModel: overrides?.selectedModel ?? rerankerSelectedModel,
              idleTimeoutMinutes:
                overrides?.idleTimeoutMinutes ?? rerankerIdleTimeoutMinutes,
            }
          : {
              baseUrl: overrides?.baseUrl ?? rerankerBaseUrl,
              model: overrides?.remoteModel ?? rerankerRemoteModel,
              apiKeyEnv: overrides?.apiKeyEnv ?? rerankerApiKeyEnv,
            }),
      },
    };
  };

  const handleToggleReranker = (enabled: boolean) => {
    const before = rerankerEnabled;
    setRerankerEnabled(enabled);
    setRerankerSaved(false);
    setRerankerSaveError(null);

    setSnapshot((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        reranker: prev.reranker
          ? {
              ...prev.reranker,
              enabled,
              mode: enabled
                ? prev.reranker.loaded
                  ? "active"
                  : prev.reranker.available
                    ? "standby"
                    : "fallback"
                : "disabled",
            }
          : undefined,
      };
    });

    saveSettingsPatch(buildRerankerPatch({ enabled }))
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.error ?? "Unknown error");
        }
        setRerankerSaved(true);
        onRefresh();
        window.setTimeout(() => setRerankerSaved(false), 2000);
      })
      .catch((err) => {
        setRerankerEnabled(before);
        setSnapshot((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            reranker: prev.reranker
              ? {
                  ...prev.reranker,
                  enabled: before,
                  mode: before
                    ? prev.reranker.loaded
                      ? "active"
                      : prev.reranker.available
                        ? "standby"
                        : "fallback"
                    : "disabled",
                }
              : undefined,
          };
        });
        setRerankerSaveError(
          err instanceof Error
            ? err.message
            : "Couldn't save the change — check your connection and try again."
        );
      });
  };

  /**
   * Choose which discovered ONNX model file to use and auto-save the selection.
   */
  const handleSelectRerankerModel = (model: string) => {
    setRerankerSelectedModel(model);
    setRerankerSaved(false);
    setRerankerSaveError(null);

    saveSettingsPatch({
      reranker: {
        provider: rerankerProvider,
        ...(rerankerProvider === "onnx"
          ? {
              enabled: rerankerEnabled,
              selectedModel: model,
              idleTimeoutMinutes: rerankerIdleTimeoutMinutes,
            }
          : {
              enabled: rerankerEnabled,
              baseUrl: rerankerBaseUrl,
              model: rerankerRemoteModel,
            }),
      },
    })
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.error ?? "Unknown error");
        }
        setRerankerSaved(true);
        onRefresh();
        window.setTimeout(() => setRerankerSaved(false), 2000);
      })
      .catch((err) => {
        setRerankerSaveError(
          err instanceof Error ? err.message : "Failed to save selected model."
        );
      });
  };

  /**
   * Update the session idle timeout (in minutes) and auto-save the change.
   */
  const handleChangeRerankerIdleTimeout = (minutes: number) => {
    setRerankerIdleTimeoutMinutes(minutes);
    setRerankerSaved(false);
    setRerankerSaveError(null);

    saveSettingsPatch({
      reranker: {
        provider: rerankerProvider,
        ...(rerankerProvider === "onnx"
          ? {
              enabled: rerankerEnabled,
              selectedModel: rerankerSelectedModel,
              idleTimeoutMinutes: minutes,
            }
          : {
              enabled: rerankerEnabled,
              baseUrl: rerankerBaseUrl,
              model: rerankerRemoteModel,
            }),
      },
    })
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.error ?? "Unknown error");
        }
        setRerankerSaved(true);
        onRefresh();
        window.setTimeout(() => setRerankerSaved(false), 2000);
      })
      .catch((err) => {
        setRerankerSaveError(
          err instanceof Error ? err.message : "Failed to save idle timeout."
        );
      });
  };

  /**
   * Handle complete deletion of a model file or directory.
   */
  const handleRerankerModelDeleted = (filename: string) => {
    if (
      rerankerSelectedModel === filename ||
      rerankerSelectedModel.includes(filename)
    ) {
      setRerankerSelectedModel("");
    }
    onRefresh();
  };

  /**
   * Explicit save handler for the RerankerTab Save button.
   */
  const handleSaveReranker = async () => {
    setRerankerSaving(true);
    setRerankerSaved(false);
    setRerankerSaveError(null);
    try {
      const result = await saveSettingsPatch(buildRerankerPatch());
      if (!result.ok) {
        throw new Error(result.error ?? "Unknown error");
      }
      setRerankerSaved(true);
      onRefresh();
      window.setTimeout(() => setRerankerSaved(false), 2000);
    } catch (err) {
      setRerankerSaveError(
        err instanceof Error
          ? err.message
          : "Failed to save reranker configuration."
      );
    } finally {
      setRerankerSaving(false);
    }
  };

  /**
   * Switch reranker provider mode (local ONNX ↔ remote). Saves immediately.
   */
  const handleRerankerProviderChange = (
    next: "onnx" | "openai-compatible"
  ) => {
    setRerankerProvider(next);
    setRerankerSaved(false);
    setRerankerSaveError(null);
    // Clear provider-specific fields when switching away from them.
    if (next === "onnx") {
      setRerankerApiKeyEnv("");
      setRerankerBaseUrl("");
      setRerankerRemoteModel("");
    }
    // Pass `next` and the cleared values as overrides — buildRerankerPatch
    // reads from state, which React hasn't flushed yet at this point
    // (async update). Without passing the cleared values, the patch would
    // persist stale baseUrl / model / apiKeyEnv from the old provider.
    saveSettingsPatch(
      buildRerankerPatch({
        provider: next,
        ...(next === "onnx"
          ? {
              baseUrl: "",
              remoteModel: "",
              apiKeyEnv: "",
            }
          : {}),
      })
    )
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.error ?? "Unknown error");
        }
        setRerankerSaved(true);
        onRefresh();
        window.setTimeout(() => setRerankerSaved(false), 2000);
      })
      .catch((err) => {
        setRerankerSaveError(
          err instanceof Error
            ? err.message
            : "Failed to save provider change."
        );
      });
  };

  const runRerankerProbe = async () => {
    if (!rerankerBaseUrl.trim() || !rerankerRemoteModel.trim()) {
      setRerankerProbeResult({
        ok: false,
        text: "Base URL and model name are required.",
      });
      return;
    }
    setRerankerProbeBusy(true);
    setRerankerProbeResult(null);
    try {
      const res = await fetch("/api/reranker/probe", {
        body: JSON.stringify({
          provider: "openai-compatible",
          baseUrl: rerankerBaseUrl.trim(),
          apiKeyEnv: rerankerApiKeyEnv.trim() || undefined,
          model: rerankerRemoteModel.trim(),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const data = (await res.json()) as {
        model?: string;
        latencyMs?: number;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setRerankerProbeResult({
        ok: true,
        text: `Connected · ${data.model ?? "model"} · ${data.latencyMs ?? 0} ms`,
      });
    } catch (error) {
      setRerankerProbeResult({
        ok: false,
        text:
          error instanceof Error
            ? error.message
            : "The connection test failed.",
      });
    } finally {
      setRerankerProbeBusy(false);
    }
  };

  /**
   * Update the remote reranker base URL. Saves immediately.
   */
  const handleRerankerBaseUrlChange = (value: string) => {
    setRerankerBaseUrl(value);
    setRerankerSaved(false);
    setRerankerSaveError(null);
    saveSettingsPatch(buildRerankerPatch({ baseUrl: value }))
      .then((result) => {
        if (!result.ok) throw new Error(result.error ?? "Unknown error");
        setRerankerSaved(true);
        onRefresh();
        window.setTimeout(() => setRerankerSaved(false), 2000);
      })
      .catch((err) => {
        setRerankerSaveError(
          err instanceof Error ? err.message : "Failed to save base URL."
        );
      });
  };

  /**
   * Update the remote reranker model name. Saves immediately.
   */
  const handleRerankerRemoteModelChange = (value: string) => {
    setRerankerRemoteModel(value);
    setRerankerSaved(false);
    setRerankerSaveError(null);
    saveSettingsPatch(buildRerankerPatch({ remoteModel: value }))
      .then((result) => {
        if (!result.ok) throw new Error(result.error ?? "Unknown error");
        setRerankerSaved(true);
        onRefresh();
        window.setTimeout(() => setRerankerSaved(false), 2000);
      })
      .catch((err) => {
        setRerankerSaveError(
          err instanceof Error ? err.message : "Failed to save model name."
        );
      });
  };

  /**
   * Update the API key environment variable name. Saves immediately.
   */
  const handleRerankerApiKeyEnvChange = (value: string) => {
    setRerankerApiKeyEnv(value);
    setRerankerSaved(false);
    setRerankerSaveError(null);
    saveSettingsPatch(buildRerankerPatch({ apiKeyEnv: value }))
      .then((result) => {
        if (!result.ok) throw new Error(result.error ?? "Unknown error");
        setRerankerSaved(true);
        onRefresh();
        window.setTimeout(() => setRerankerSaved(false), 2000);
      })
      .catch((err) => {
        setRerankerSaveError(
          err instanceof Error
            ? err.message
            : "Failed to save API key variable name."
        );
      });
  };

  return {
    rerankerEnabled,
    rerankerSelectedModel,
    rerankerProvider,
    rerankerBaseUrl,
    rerankerRemoteModel,
    rerankerApiKeyEnv,
    rerankerIdleTimeoutMinutes,
    rerankerSaved,
    rerankerSaveError,
    rerankerProbeBusy,
    rerankerProbeResult,
    rerankerSaving,
    handleToggleReranker,
    handleSelectRerankerModel,
    handleChangeRerankerIdleTimeout,
    handleRerankerModelDeleted,
    handleSaveReranker,
    handleRerankerProviderChange,
    runRerankerProbe,
    handleRerankerBaseUrlChange,
    handleRerankerRemoteModelChange,
    handleRerankerApiKeyEnvChange,
  };
}
