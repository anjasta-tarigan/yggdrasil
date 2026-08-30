import { Card, CardContent } from "@/components/ui/card";

type SettingsSnapshot = {
  ai: { baseUrl: string | null; modelId: string; apiKeyConfigured: boolean };
  embedding: {
    provider: "server" | "openai-compatible" | "ollama";
    baseUrl: string | null;
    model: string;
    apiKeyConfigured: boolean;
    dimensions: number | null;
    chunkSize: number;
    chunkOverlap: number;
    fallback: string;
  };
  database: {
    engine: string;
    driver: string;
    features: string[];
    path: string;
    sizeBytes: number;
    chatCount: number;
    messageCount: number;
    memories: { episodic: number; semantic: number; working: number };
    queue: { pending: number; completed: number; failed: number };
  };
  tools: Array<{
    name: string;
    description: string;
    configured: boolean;
    requires: string | null;
  }>;
  webSearch?: {
    providers: Array<{
      kind: string;
      enabled: boolean;
      ready: boolean;
      coolingDown: boolean;
    }>;
    chain: string[];
  };
  about: { name: string; version: string; stack: string };
  store: unknown;
};

type ProviderConfig = {
  id: string;
  kind: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function SettingsSummary({
  tab,
  settings,
  providers,
}: {
  tab: string;
  settings: SettingsSnapshot | null;
  providers: ProviderConfig[];
}) {
  let summaryText = "";
  switch (tab) {
    case "general":
      summaryText = "General assistant preferences — theme and global behavior.";
      break;
    case "provider": {
      const count = providers.length;
      summaryText = `${count} AI provider${count === 1 ? "" : "s"} configured.`;
      break;
    }
    case "embedding": {
      const emb = settings?.embedding;
      const provider = emb?.provider ?? "unknown";
      const model = emb?.model ?? "none";
      summaryText = `Embedding provider: ${provider} using model "${model}".`;
      break;
    }
    case "database": {
      const db = settings?.database;
      if (!db) {
        summaryText = "No database information available.";
      } else {
        const size = formatBytes(db.sizeBytes ?? 0);
        summaryText = `SQLite engine, ${size} — ${db.chatCount ?? 0} chats, ${db.messageCount ?? 0} messages.`;
      }
      break;
    }
    case "tools": {
      const tools = settings?.tools ?? [];
      const chain = settings?.webSearch?.chain ?? [];
      const chainLabel = chain.length > 0 ? chain.join(" → ") : "none";
      summaryText = `${tools.length} tools available, web search: ${chainLabel}.`;
      break;
    }
    case "about": {
      const about = settings?.about;
      summaryText = `Version ${about?.version ?? "—"}, stack ${about?.stack ?? "—"}.`;
      break;
    }
    default:
      summaryText = "";
  }

  return (
    <Card data-testid={`summary-${tab}`} className="h-fit">
      <CardContent className="pt-4 text-sm text-muted-foreground">
        <p>{summaryText}</p>
      </CardContent>
    </Card>
  );
}