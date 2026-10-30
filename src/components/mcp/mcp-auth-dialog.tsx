"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SealCheck } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Auth step within the install flow: determines which form to show.
 */
type AuthStep =
  | "method" // Choose: OAuth, API Key, or None
  | "oauth_authorizing"
  | "oauth_callback" // Waiting for user to complete OAuth in a browser tab
  | "api_key";

export type McpServerAuthMeta = {
  /** Authentication method declared by the server. */
  method: "oauth" | "api_key" | "none";
  /** OAuth authorization URL (for oauth method). */
  authUrl?: string;
  /** OAuth scopes requested (for oauth method). */
  oauthScopes?: string[];
  /** API key header name (for api_key method, e.g. "Authorization"). */
  apiKeyName?: string;
  /** Server display name for messaging. */
  serverName?: string;
};

export type AuthDialogResult = {
  auth: {
    method: "oauth" | "api_key" | "env_vars" | "none";
    status: "configured" | "needs_refresh";
    oauthScopes?: string[];
    apiKeyName?: string;
    lastAuthenticatedAt?: number;
  };
  apiKey?: string;
  apiKeyName?: string;
};

interface McpAuthDialogProps {
  open: boolean;
  onClose: () => void;
  serverName: string;
  serverId?: string;
  /** Auth metadata from the marketplace detail or server config. */
  authMeta?: McpServerAuthMeta;
  /** Why OAuth discovery was unavailable, when known. */
  discoveryError?: string | null;
  /** Called when the user completes the auth flow. */
  onAuthComplete: (result: AuthDialogResult) => void | Promise<void>;
  /** Called when the user skips auth entirely. */
  onSkip: () => void;
}

/**
 * Auth dialog for MCP server installation.
 *
 * Branches on the server's auth method:
 *  - OAuth: opens an authorize URL in a new tab, polls for completion via
 *    callback, then exchanges the code server-side.
 *  - API Key: prompts for a key + header name.
 *  - None: marks as configured with no secrets.
 */
export function McpAuthDialog({
  open,
  onClose,
  serverName,
  serverId,
  authMeta,
  discoveryError,
  onAuthComplete,
  onSkip,
}: McpAuthDialogProps) {
  const [step, setStep] = useState<AuthStep>("method");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyName, setApiKeyName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs for timer IDs so we can clean them up on unmount or step change.
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the latest `busy` value so the timeout closure reads the current
  // value instead of the stale render-time capture.
  const busyRef = useRef(false);
  // Track consecutive poll failures to surface persistent errors to the user.
  const consecutiveErrorsRef = useRef(0);
  // Guard against state updates after unmount.
  const mountedRef = useRef(true);
  // Track the previous `open` value so reopening the dialog starts clean.
  const prevOpenRef = useRef(open);
  // Server-clock time the current flow started; status polling ignores auth
  // that predates it so re-authentication does not complete instantly.
  const sinceRef = useRef<number | undefined>(undefined);

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopPolling();
    setStep("method");
    setApiKey("");
    setApiKeyName("");
    setError(null);
    setBusy(false);
    busyRef.current = false;
    consecutiveErrorsRef.current = 0;
    sinceRef.current = undefined;
  }, [stopPolling]);

  // Clean up timers when the dialog unmounts.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  // Reset transient state whenever the dialog transitions to open so a
  // previous failed attempt does not leak into the next one.
  useEffect(() => {
    if (open && !prevOpenRef.current) reset();
    prevOpenRef.current = open;
  }, [open, reset]);

  /** Abort the flow and show `message` back on the method step. */
  const fail = useCallback(
    (message: string) => {
      stopPolling();
      if (!mountedRef.current) return;
      setBusy(false);
      busyRef.current = false;
      setError(message);
      setStep("method");
    },
    [stopPolling]
  );

  const pollServerStatus = useCallback(
    async (consecutiveErrors: number) => {
      if (!mountedRef.current) return;

      let status: { status?: "pending" | "complete" | "error"; error?: string } | null;
      try {
        const check = await fetch("/api/mcp/auth/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverName, serverId, since: sinceRef.current }),
        });
        status = (await check.json().catch(() => null)) as {
          status?: "pending" | "complete" | "error";
          error?: string;
        } | null;
        if (!check.ok && status?.status !== "error") {
          throw new Error(status?.error ?? `Status check failed: ${check.status}`);
        }
        consecutiveErrorsRef.current = 0;
      } catch {
        consecutiveErrorsRef.current = consecutiveErrors + 1;
        if (consecutiveErrorsRef.current >= 3) {
          fail(
            "Network error polling auth status. Check your connection and try again."
          );
        }
        // Otherwise keep polling — transient network blips should not
        // abort the flow on a single failed request.
        return;
      }

      if (!mountedRef.current) return;

      if (status?.status === "complete") {
        stopPolling();
        setBusy(false);
        busyRef.current = false;
        onAuthComplete({
          auth: {
            method: "oauth",
            status: "configured",
            oauthScopes: authMeta?.oauthScopes,
            lastAuthenticatedAt: Date.now(),
          },
        });
      } else if (status?.status === "error") {
        fail(status.error ?? "OAuth flow failed.");
      }
      // For "pending", the interval will fire again.
    },
    [serverName, serverId, onAuthComplete, authMeta, stopPolling, fail]
  );

  // Listen for the cross-tab postMessage from the auth-complete page.
  useEffect(() => {
    if (step !== "oauth_callback") return;

    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const matches = serverId
        ? event.data?.serverId === serverId
        : event.data?.serverName === serverName;
      if (!matches) return;

      if (event.data?.type === "mcp-auth-error") {
        fail(
          typeof event.data.error === "string"
            ? event.data.error
            : "OAuth flow failed."
        );
      } else if (event.data?.type === "mcp-auth-complete") {
        void pollServerStatus(0);
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [step, serverName, serverId, pollServerStatus, fail]);

  const handleOAuth = async () => {
    setStep("oauth_authorizing");
    setBusy(true);
    busyRef.current = true;
    setError(null);
    consecutiveErrorsRef.current = 0;
    sinceRef.current = undefined;

    // Open the popup synchronously, inside the user gesture. Opening it after
    // `await fetch` counts as a popup and gets blocked by most browsers. We
    // deliberately omit "noopener": it makes `window.open` return null and
    // severs `window.opener`, which the completion page needs for postMessage.
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      fail("Could not open authorization tab. Allow popups for this site and try again.");
      return;
    }

    try {
      // Start the auth flow server-side — it discovers the OAuth metadata
      // and returns the authorization URL to redirect the user.
      const res = await fetch("/api/mcp/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverName,
          serverId,
          authUrl: authMeta?.authUrl,
          scopes: authMeta?.oauthScopes,
          redirectUri: `${window.location.origin}/api/mcp/auth/callback`,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        authUrl?: string;
        startedAt?: number;
        error?: string;
      } | null;
      if (!res.ok || !data?.authUrl) {
        throw new Error(data?.error ?? `Auth flow request failed: ${res.status}`);
      }
      sinceRef.current =
        typeof data.startedAt === "number" ? data.startedAt : undefined;

      // Send the popup to the provider. If a popup blocker or an extension
      // closed it we can still poll: the callback records status server-side.
      try {
        popup.location.href = data.authUrl;
      } catch {
        window.open(data.authUrl, "_blank", "noopener,noreferrer");
      }

      setStep("oauth_callback");

      // Poll for auth completion every 2 seconds, regardless of whether we
      // still hold a usable popup handle.
      pollIntervalRef.current = setInterval(() => {
        void pollServerStatus(consecutiveErrorsRef.current);
      }, 2000);

      // Safety timeout: stop polling after 5 minutes.
      timeoutRef.current = setTimeout(() => {
        fail("OAuth flow timed out. Please try again.");
      }, 5 * 60_000);
    } catch (err) {
      try {
        popup.close();
      } catch {
        // ignore
      }
      fail(
        err instanceof Error ? err.message : "Failed to start OAuth flow."
      );
    }
  };

  const handleApiKey = () => {
    if (!apiKey.trim()) {
      setError("An API key is required.");
      return;
    }
    if (!apiKeyName.trim()) {
      setError("The key name/header is required.");
      return;
    }
    setError(null);
    void Promise.resolve(onAuthComplete({
      auth: {
        method: "api_key",
        status: "configured",
        apiKeyName: apiKeyName.trim(),
        lastAuthenticatedAt: Date.now(),
      },
      apiKey: apiKey.trim(),
      apiKeyName: apiKeyName.trim(),
    })).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not save credentials"));
  };

  const handleNone = () => {
    onAuthComplete({
      auth: {
        method: "none",
        status: "configured",
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Configure authentication for {serverName || "server"}
          </DialogTitle>
          <DialogDescription>
            This server requires authentication before it can be connected.
            Choose how you would like to authenticate.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
            {error}
          </div>
        )}

        {step === "method" && (
          <div className="space-y-3 py-2">
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={handleOAuth}
              disabled={busy}
            >
              <SealCheck className="size-4 mr-2" />
              OAuth
            </Button>
            {discoveryError && (
              <p className="text-muted-foreground text-xs">
                OAuth discovery warning: {discoveryError}
              </p>
            )}

            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => setStep("api_key")}
              disabled={busy}
            >
              API key (optional)
            </Button>

            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={handleNone}
              disabled={busy}
            >
              Connect without auth
            </Button>
          </div>
        )}

        {step === "api_key" && (
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <label className="text-sm" htmlFor="api-key-name">
                Header or environment variable name
              </label>
              <Input
                id="api-key-name"
                placeholder="Authorization"
                value={apiKeyName || authMeta?.apiKeyName || ""}
                onChange={(e) => setApiKeyName(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm" htmlFor="api-key-value">
                API key
              </label>
              <Input
                id="api-key-value"
                type="password"
                placeholder="Enter your API key…"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={busy}
              />
            </div>
          </div>
        )}

        {(step === "oauth_authorizing" || step === "oauth_callback") && (
          <div className="space-y-3 py-4 text-center">
            <div className="flex justify-center">
              <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
            <p className="text-sm">
              {step === "oauth_authorizing"
                ? "Preparing the authorization request…"
                : "Complete authentication in the browser tab that opened."}
            </p>
            <p className="text-muted-foreground text-xs">
              We will automatically proceed when you return.
            </p>
          </div>
        )}

        <DialogFooter className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              stopPolling();
              reset();
              onSkip();
            }}
            disabled={busy && step !== "oauth_callback"}
          >
            Skip (connect later)
          </Button>
          {step !== "method" &&
          step !== "oauth_callback" &&
          step !== "oauth_authorizing" ? (
            <Button size="sm" onClick={handleApiKey} disabled={busy}>
              {busy ? "Saving…" : "Connect"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
