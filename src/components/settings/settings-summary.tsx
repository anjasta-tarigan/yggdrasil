import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import type { ProviderConfig } from "@/lib/settings";

/**
 * The slice of the Settings API snapshot the summary needs. Kept local
 * (structural) rather than importing SettingsView's full snapshot type so
 * the panel stays decoupled from the view's module graph. Field shapes
 * mirror the /api/settings snapshot.
 */
export type SettingsSummaryData = {
  embedding?: { provider?: string; model?: string };
  database?: {
    engine?: string;
    features?: string[];
    sizeBytes?: number;
    chatCount?: number;
    messageCount?: number;
    memories?: { episodic: number; semantic: number; working: number };
  };
  tools?: Array<{
    name: string;
    description: string;
    configured: boolean;
    requires: string | null;
  }>;
  webSearch?: { chain?: string[] };
  about?: { name?: string; version?: string; stack?: string };
};

export function SettingsSummary({
  tab,
  settings,
  providers,
}: {
  tab: string;
  settings: SettingsSummaryData | null;
  providers: ProviderConfig[];
}) {
  const providerCount = providers.length;
  const configuredTools = (settings?.tools ?? []).filter((t) => t.configured);
  const searchChain = settings?.webSearch?.chain ?? [];

  let content: ReactNode = null;

  switch (tab) {
    case "general":
      content = (
        <p>Theme preference and general assistant behavior.</p>
      );
      break;
    case "provider":
      content = (
        <p>
          {providerCount} AI provider{providerCount === 1 ? "" : "s"} added
          alongside the built-in server provider.
          {providerCount === 0 ? " Add one below to get started." : ""}
        </p>
      );
      break;
    case "embedding":
      content = (
        <p>
          Embedding provider: {settings?.embedding?.provider ?? "none"}
          {settings?.embedding?.model
            ? ` (model: ${settings.embedding.model})`
            : ""}
          {settings?.embedding?.provider ? "" : " — not configured yet."}
        </p>
      );
      break;
    case "database": {
      const db = settings?.database;
      content = (
        <p>
          {db?.engine ?? "SQLite"} engine
          {db?.features?.length ? ` with ${db.features.join(", ")}` : ""}.
          {typeof db?.chatCount === "number"
            ? ` ${db.chatCount} chat(s), ${db.messageCount ?? 0} messages.`
            : ""}
        </p>
      );
      break;
    }
    case "tools":
      content = (
        <p>
          {configuredTools.length}/{settings?.tools?.length ?? 0} assistant
          tool(s) configured
          {searchChain.length > 0
            ? `; web search chain: ${searchChain.join(" → ")}.`
            : "; web search has no active provider."}
        </p>
      );
      break;
    case "about":
      content = (
        <p>
          {settings?.about?.name ?? "Yggdrasil"}{" "}
          {settings?.about?.version ? `v${settings.about.version}` : ""}
          {settings?.about?.stack ? ` — ${settings.about.stack}` : ""}
        </p>
      );
      break;
    default:
      content = <p>Settings summary</p>;
  }

  return (
    <Card data-testid={`summary-${tab}`} className="h-fit">
      <CardContent className="pt-4 text-sm text-muted-foreground">
        {content}
      </CardContent>
    </Card>
  );
}