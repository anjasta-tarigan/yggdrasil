"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExperimentalProviderBanner } from "./experimental-provider-banner";
import { DeepSeekWebProviderDialog } from "./deepseek-web-provider-dialog";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  fetchProviderRegistry,
  fetchWebProviderCatalog,
  type ProviderConfig,
  type WebProviderCatalogEntry,
} from "@/lib/settings";

/**
 * DeepSeek Web is listed apart from the API providers (Spec §10.1) because it
 * is a browser-session adapter, not a key-based provider. This section owns its
 * own catalog read: the web-provider surface is a separate route from the
 * provider registry, and a disabled feature must not offer a session action
 * (Spec §11.2) — a null catalog renders nothing at all.
 *
 * `registryProviders` is the registry the caller already loaded. The discovered
 * model list lives there (Spec §4.4); session status lives on the catalog.
 */
export function ExperimentalWebProvidersSection({
  registryProviders,
  addModel,
}: {
  registryProviders: ProviderConfig[];
  /** Opens the shared manual model form (Spec §15.14). */
  addModel?: (providerId: string) => void;
}) {
  const [catalog, setCatalog] = useState<WebProviderCatalogEntry[] | null>(null);
  const [dialogProviderId, setDialogProviderId] = useState<string | null>(null);
  // The discovery merge writes models server-side, so after a save the registry
  // this component was handed is stale. A locally re-read copy wins until the
  // parent's own view catches up (Spec §8.1).
  const [freshRegistry, setFreshRegistry] = useState<ProviderConfig[] | null>(null);

  const loadCatalog = useCallback(async () => {
    setCatalog(await fetchWebProviderCatalog());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await fetchWebProviderCatalog();
      if (!cancelled) setCatalog(entries);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Null means the surface is unavailable (disabled or unreachable): render
  // nothing rather than an empty shell that implies a configurable provider.
  if (catalog === null || catalog.length === 0) return null;

  const activeDialogEntry = dialogProviderId
    ? catalog.find((entry) => entry.id === dialogProviderId)
    : undefined;
  const registry = freshRegistry ?? registryProviders;

  async function handleSaved() {
    await loadCatalog();
    setFreshRegistry(await fetchProviderRegistry());
  }

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div>
        <p className="font-medium text-sm">Experimental Web Providers</p>
        <p className="text-muted-foreground text-xs">
          Browser-session integrations. These are not official APIs and are not
          supported by the provider.
        </p>
      </div>

      {catalog.map((entry) => {
        const registryEntry = registry.find(
          (provider) => provider.id === entry.id
        );
        const modelCount = registryEntry?.models?.length ?? entry.models.length;
        const isVerified = entry.session.status === "verified";
        const lastCheckedAt = entry.session.lastCheckedAt
          ? Date.parse(entry.session.lastCheckedAt)
          : Number.NaN;

        return (
          <div className="flex flex-col gap-3 rounded-lg border p-4" key={entry.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="flex flex-wrap items-center gap-2 font-medium text-sm">
                  <span className="truncate">{entry.name}</span>
                  <Badge
                    className="text-amber-600 dark:text-amber-400"
                    variant="outline"
                  >
                    Experimental Web Provider
                  </Badge>
                </p>
                <p className="text-muted-foreground text-xs">
                  Session: {isVerified ? "Verified" : "Not configured"}
                </p>
                <p className="text-muted-foreground text-xs">
                  Models: {modelCount}
                </p>
                {isVerified && Number.isFinite(lastCheckedAt) && (
                  <p className="text-muted-foreground text-xs">
                    Last checked {formatRelativeTime(lastCheckedAt)}
                  </p>
                )}
                {modelCount === 0 && isVerified && (
                  <p className="text-muted-foreground text-xs">
                    No models discovered yet. Add one manually or re-run
                    discovery after saving the session.
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {addModel && (
                  <Button
                    aria-label={`Add model manually to ${entry.name}`}
                    onClick={() => addModel(entry.id)}
                    type="button"
                    variant="outline"
                  >
                    Add model manually
                  </Button>
                )}
                <Button
                  aria-label={`${isVerified ? "Manage session" : "Configure"} ${entry.name}`}
                  onClick={() => setDialogProviderId(entry.id)}
                  type="button"
                  variant="outline"
                >
                  {isVerified ? "Manage session" : "Configure"}
                </Button>
              </div>
            </div>
            <ExperimentalProviderBanner />
          </div>
        );
      })}

      {activeDialogEntry && (
        <DeepSeekWebProviderDialog
          onClose={() => setDialogProviderId(null)}
          onSaved={() => void handleSaved()}
          open
        />
      )}
    </div>
  );
}
