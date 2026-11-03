"use client";

import {
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  getWebSearchProviders,
  saveWebSearchProviders,
  type WebSearchProviderKind,
} from "@/lib/settings";
import { WEB_SEARCH_PROVIDER_META } from "@/components/settings/shared";
import {
  saveSettingsPatch,
  webSearchFormFromEntries,
  type SettingsSnapshot,
  type WebSearchForm,
} from "@/components/settings/snapshot";

/**
 * Tools-tab state and handlers, owned by the settings shell.
 *
 * Covers the web search provider chain (multi-provider keys/URLs) and per-tool
 * enable/disable toggles with optimistic UI and failure rollback.
 *
 * See `docs/adr/2026-11-03-settings-view-tab-state-hooks.md`.
 */
export function useToolsSettings({
  snapshot,
  onRefresh,
  setSnapshot,
}: {
  /** The latest `GET /api/settings` snapshot, or null before the first load. */
  snapshot: SettingsSnapshot | null;
  /** Bump the shell's snapshot version so status badges and effective chains re-read. */
  onRefresh: () => void;
  /**
   * Patch the shell's snapshot copy. The tool toggle updates `tools`
   * optimistically and rolls back on failure.
   */
  setSnapshot: Dispatch<SetStateAction<SettingsSnapshot | null>>;
}) {
  // ---- Web search provider chain (powers the web_search tool) ----
  const [wsForm, setWsForm] = useState<WebSearchForm>(() =>
    webSearchFormFromEntries(getWebSearchProviders())
  );
  const [wsSaved, setWsSaved] = useState(false);
  const [wsSaveError, setWsSaveError] = useState<string | null>(null);

  // ---- Per-tool enable/disable (Chat tools card) ----
  // Local overlay of the server's enabled flags: flips are optimistic;
  // save persists the derived disabled list via PUT /api/settings.
  const [toolOverrides, setToolOverrides] = useState<Record<string, boolean>>(
    {}
  );
  const [toolsSaved, setToolsSaved] = useState(false);
  const [toolsSaveError, setToolsSaveError] = useState<string | null>(null);

  // Re-sync the web search chain from the snapshot.
  useEffect(() => {
    if (!snapshot) return;
    const storedWs = snapshot.store?.websearch?.providers;
    if (Array.isArray(storedWs) && storedWs.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate form from server snapshot
      setWsForm(webSearchFormFromEntries(storedWs));
    } else if (snapshot.webSearch) {
      setWsForm(
        webSearchFormFromEntries(
          snapshot.webSearch.providers.map((p) => ({
            kind: p.kind,
            enabled: p.enabled,
          }))
        )
      );
    }
  }, [snapshot]);

  const updateWsForm = (
    kind: WebSearchProviderKind,
    patch: Partial<WebSearchForm[WebSearchProviderKind]>
  ) => {
    setWsForm((prev) => ({ ...prev, [kind]: { ...prev[kind], ...patch } }));
  };

  const saveWebSearch = async () => {
    setWsSaveError(null);
    const providers = WEB_SEARCH_PROVIDER_META.map((meta) => ({
      kind: meta.kind,
      enabled: wsForm[meta.kind].enabled,
      apiKeys: wsForm[meta.kind].apiKeys.filter(
        (key) => !wsForm[meta.kind].removeApiKeyIds.includes(key.id)
      ),
      baseUrl: wsForm[meta.kind].baseUrl.trim() || undefined,
    }));
    const keyChanges = WEB_SEARCH_PROVIDER_META
      .filter((meta) => !meta.needsUrl)
      .map(({ kind }) => ({
        kind,
        apiKeys: [
          ...providers.find((provider) => provider.kind === kind)!.apiKeys,
          ...(wsForm[kind].apiKey.trim()
            ? [
                {
                  id: `key-${crypto.randomUUID()}`,
                  value: wsForm[kind].apiKey.trim(),
                  configured: true as const,
                },
              ]
            : []),
        ],
      }));
    try {
      await saveWebSearchProviders(providers, keyChanges);
      setWsForm((previous) =>
        Object.fromEntries(
          WEB_SEARCH_PROVIDER_META.map(({ kind }) => [
            kind,
            {
              ...previous[kind],
              apiKey: "",
              apiKeys:
                keyChanges
                  .find((change) => change.kind === kind)
                  ?.apiKeys.map(({ id }) => ({ id, configured: true as const })) ??
                providers.find((provider) => provider.kind === kind)!.apiKeys,
              removeApiKeyIds: [],
            },
          ])
        ) as unknown as WebSearchForm
      );
      setWsSaved(true);
      window.setTimeout(() => setWsSaved(false), 2000);
      onRefresh();
    } catch (error) {
      setWsSaveError(
        error instanceof Error ? error.message : "Failed to save settings"
      );
    }
  };

  /**
   * Flip one tool toggle and persist immediately — no separate Save
   * button. Optimistic: the switch moves at once; on failure it rolls
   * back to the snapshot value and the error surfaces inline. This
   * removes the flip-without-saving trap entirely.
   */
  const toggleTool = (name: string, enabled: boolean) => {
    // Snapshot the pre-flip state for rollback before any setState.
    const before =
      snapshot?.tools.find((tool) => tool.name === name)?.enabled ?? enabled;
    const overridesBefore = { ...toolOverrides };

    setToolOverrides((prev) => ({ ...prev, [name]: enabled }));
    setToolsSaved(false);
    setToolsSaveError(null);
    setSnapshot((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        tools: prev.tools.map((tool) =>
          tool.name === name ? { ...tool, enabled } : tool
        ),
      };
    });

    // Disabled set = snapshot values, overlay overrides, then this flip.
    const disabled = (snapshot?.tools ?? [])
      .filter((tool) => {
        if (tool.name === name) return !enabled;
        const override = toolOverrides[tool.name];
        const enabledNow = override !== undefined ? override : tool.enabled;
        return !enabledNow;
      })
      .map((tool) => tool.name);

    saveSettingsPatch({ toolToggles: { disabled } })
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.error ?? "Unknown error");
        }
        setToolsSaved(true);
        setToolOverrides({});
        onRefresh();
        window.setTimeout(() => setToolsSaved(false), 2000);
      })
      .catch(() => {
        // Roll back the optimistic flip so the switch never lies.
        setToolOverrides(overridesBefore);
        setSnapshot((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            tools: prev.tools.map((tool) =>
              tool.name === name ? { ...tool, enabled: before } : tool
            ),
          };
        });
        setToolsSaveError(
          "Couldn't save the change — check your connection and try again."
        );
      });
  };

  return {
    wsForm,
    wsSaved,
    wsSaveError,
    updateWsForm,
    saveWebSearch,
    toolOverrides,
    toolsSaved,
    toolsSaveError,
    toggleTool,
  };
}
