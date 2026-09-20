"use client";

import { experimental_MCPAppRenderer } from "@ai-sdk/react";
import type {
  MCPAppBridgeHandlers,
  MCPAppMetadata,
  MCPAppResource,
  MCPAppSandboxConfig,
} from "@ai-sdk/react";
import type { DynamicToolUIPart, ToolUIPart, UITools } from "ai";
import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";

import type { MCPAppInfo } from "@/lib/ai/mcp/manager";

// Alias the experimental renderer under a PascalCase name so JSX treats it
// as a component rather than an intrinsic element.
const MCPAppRendererInner = experimental_MCPAppRenderer;

export type McpAppRendererProps = {
  /** The tool UI part from a UIMessage; the renderer extracts app metadata
   * from `part.toolMetadata.app` internally. */
  toolPart: ToolUIPart<UITools> | DynamicToolUIPart;
  /** App info collected by `collectMcpTools` — used to resolve which
   * server a given `ui://` resourceUri belongs to for proxy routing. */
  apps?: MCPAppInfo[];
  /** Called when a `ui://` resource is about to be fetched. */
  onResourceRead?: (uri: string) => void;
  /** Optional sandbox URL override (defaults to the host proxy route). */
  sandboxUrl?: string;
  /** Optional fallback rendered when the part has no MCP App or loading fails. */
  fallback?: ReactNode;
};

const DEFAULT_SANDBOX: MCPAppSandboxConfig = {
  url: "/mcp-app-sandbox",
  className: "h-80 w-full rounded-lg border",
  style: { border: 0 },
};

/**
 * Resolve the serverId for a given resource URI from the `apps` mapping
 * produced by `collectMcpTools`. Returns `undefined` when no match is found.
 */
function resolveServerId(
  apps: MCPAppInfo[] | undefined,
  resourceUri: string,
): string | undefined {
  return apps?.find((a) => a.resourceUri === resourceUri)?.serverId;
}

/**
 * Extract the `resourceUri` from a tool UI part's MCP App metadata.
 * Returns `undefined` when the part is not an MCP App tool.
 */
export function extractResourceUri(
  part: ToolUIPart<UITools> | DynamicToolUIPart,
): string | undefined {
  const appMeta = part.toolMetadata?.app;
  if (
    appMeta != null &&
    typeof appMeta === "object" &&
    !Array.isArray(appMeta)
  ) {
    const uri = (appMeta as { resourceUri?: unknown }).resourceUri;
    if (typeof uri === "string" && uri.startsWith("ui://")) {
      return uri;
    }
  }
  return undefined;
}
/**
 * Extract the `serverId` from a tool UI part's MCP App metadata.
 *
 * Prefers `serverId` embedded in `part.toolMetadata.app` (injected by
 * `collectMcpTools` on the server side). Falls back to resolving from the
 * `apps` prop for backward compatibility with clients that don't receive
 * `serverId` in the streamed metadata.
 */
function extractServerId(
  part: ToolUIPart<UITools> | DynamicToolUIPart,
  apps: MCPAppInfo[] | undefined,
  resourceUri: string | undefined,
): string | undefined {
  const appMeta = part.toolMetadata?.app;
  if (
    appMeta != null &&
    typeof appMeta === "object" &&
    !Array.isArray(appMeta) &&
    "serverId" in appMeta
  ) {
    const sid = appMeta.serverId;
    if (typeof sid === "string") return sid;
  }
  return resolveServerId(apps, resourceUri ?? "");
}
/**
 * React wrapper around `experimental_MCPAppRenderer` from `@ai-sdk/react`.
 *
 * Bridges the iframe's JSON-RPC requests to the MCP Apps host API routes:
 * - `resources/read` → `GET /api/mcp/mcp-app-host/read-resource?uri=…&serverId=…`
 * - `tools/call`     → `POST /api/mcp/mcp-app-host/call-tool`
 * - `resources/open-link` → opens the URL in a new tab.
 *
 * The component resolves the correct `serverId` via `extractServerId`, which
 * prefers `serverId` embedded in `toolMetadata.app` (injected by
 * `collectMcpTools` on the server side) and falls back to the `apps` prop
 * for backward compatibility. The resolved `serverId` is injected into every
 * proxied request. The sandbox iframe is rendered with the CSP and
 * permission policy derived from the app resource by `experimental_MCPAppRenderer`'s
 * internal `MCPAppFrame`.
 */
export function McpAppRenderer({
  toolPart,
  apps,
  onResourceRead,
  sandboxUrl,
  fallback = null,
}: McpAppRendererProps) {
  const resourceUri = extractResourceUri(toolPart);
  const serverId = extractServerId(toolPart, apps, resourceUri);
  const sandbox = useMemo<MCPAppSandboxConfig>(
    () => ({ ...DEFAULT_SANDBOX, ...(sandboxUrl ? { url: sandboxUrl } : {}) }),
    [sandboxUrl],
  );

  const loadResource = useCallback(
    async (app: MCPAppMetadata): Promise<MCPAppResource> => {
      onResourceRead?.(app.resourceUri);

      const params = new URLSearchParams();
      params.set("uri", app.resourceUri);
      if (serverId) params.set("serverId", serverId);

      const response = await fetch(
        `/api/mcp/mcp-app-host/read-resource?${params.toString()}`,
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(
          error?.error ??
            `Failed to load MCP App resource (${response.status})`,
        );
      }

      return (await response.json()) as MCPAppResource;
    },
    [serverId, onResourceRead],
  );

  const handlers = useMemo<MCPAppBridgeHandlers>(
    () => ({
      // App-visible tool calls proxied through the call-tool API route,
      // which validates the tool is app-visible before forwarding.
      callTool: (params: { name: string; arguments?: Record<string, unknown> }) =>
        fetch("/api/mcp/mcp-app-host/call-tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serverId,
            toolName: params.name,
            arguments: params.arguments ?? {},
          }),
        }).then(async (response) => {
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(
              error?.error ?? `Tool call failed (${response.status})`,
            );
          }
          return response.json();
        }),

      // App-initiated resource reads are restricted to ui:// resources
      // (validated server-side) and routed to the correct server.
      readResource: ({ uri }: { uri: string }) => {
        const params = new URLSearchParams();
        params.set("uri", uri);
        if (serverId) params.set("serverId", serverId);
        return fetch(
          `/api/mcp/mcp-app-host/read-resource?${params.toString()}`,
        ).then(async (response) => {
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(
              error?.error ?? `Resource read failed (${response.status})`,
            );
          }
          return response.json();
        });
      },

      // Open links in a new tab — deny-by-default for other protocols is
      // enforced server-side in the bridge's `openLink` handler.
      openLink: ({ url }: { url: string }) => {
        window.open(url, "_blank", "noopener,noreferrer");
        return {};
      },
    }),
    [serverId],
  );

  return (
    <MCPAppRendererInner
      part={toolPart}
      sandbox={sandbox}
      loadResource={loadResource}
      handlers={handlers}
      fallback={fallback}
    />
  );
}
