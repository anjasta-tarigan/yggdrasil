import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import type { ProviderConfig } from "@/lib/settings";

/**
 * The slice of the Settings API snapshot the summary needs. Kept local
 * (structural) rather than importing SettingsView's full snapshot type so
 * the panel stays decoupled from the view's module graph.
 */
export type SettingsSummaryData = {
  embedding?: { provider?: string; model?: string };
  database?: { engine?: string; features?: string[] };
  tools?: { webSearch?: string[]; skills?: string[] };
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

  let content: ReactNode = null;

  switch (tab) {
    case "general":
      content = <p>General assistant preferences and behavior settings.</p>;
      break;
    case "provider":
      content = (
        <p>
          {providerCount} AI provider{providerCount === 1 ? "" : "s"} configured.
          {providerCount > 0 ? " Ready for use." : " Add one to get started."}
        </p>
      );
      break;
    case "embedding":
      const emb = settings?.embedding;
      content = (
        <p>
          Embedding provider: {emb?.provider ?? "none"}
          {emb?.model ? ` (model: ${emb.model})` : ""}
          {!emb?.provider ? " — not configured yet." : ""}
        </p>
      );
      break;
    case "database":
      const db = settings?.database;
      content = (
        <p>
          {db?.engine ?? "SQLite"} engine
          {db?.features?.length ? ` with ${db.features.join(", ")}` : ""}.
        </p>
      );
      break;
    case "tools":
      const tools = settings?.tools;
      content = (
        <p>
          {tools?.webSearch?.length ?? 0} web search provider(s),{" "}
          {tools?.skills?.length ?? 0} skill(s) enabled.
        </p>
      );
      break;
    case "about":
      content = (
        <p>
          Yggdrasil v0.1.0 —{" "}
          <a
            href="https://github.com/anjasta-tarigan/yggdrasil"
            className="text-primary underline-offset-2 hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
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