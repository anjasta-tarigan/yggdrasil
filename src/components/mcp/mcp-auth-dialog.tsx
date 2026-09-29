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
  /** Auth metadata from the marketplace detail or server config. */
  authMeta?: McpServerAuthMeta;
  /** Called when the user completes the auth flow. */
  onAuthComplete: (result: AuthDialogResult) => void;
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
  authMeta,
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

  // Clean up timers when the dialog unmounts.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  const pollServerStatus = useCallback(
    async (consecutiveErrors: number) => {
      if (!mountedRef.current) return;

      let status: { status?: "pending" | "complete" | "error"; error?: string } | null;
      try {
        const check = await fetch("/api/mcp/auth/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverName }),
        });
        status = (await check.json().catch(() => null)) as {
          status?: "pending" | "complete" | "error";
          error?: string;
        } | null;
        consecutiveErrorsRef.current = 0;
      } catch {
        consecutiveErrorsRef.current = consecutiveErrors + 1;
        if (consecutiveErrorsRef.current >= 3) {
          stopPolling();
          if (mountedRef.current) {
            setBusy(false);
            busyRef.current = false;
            setError(
              "Network error polling auth status. Check your connection and try again."
            );
            setStep("method");
          }
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
        stopPolling();
        setBusy(false);
        busyRef.current = false;
        setError(status.error ?? "OAuth flow failed.");
        setStep("method");
      }
      // For "pending", the interval will fire again.
    },
    [serverName, onAuthComplete, authMeta, stopPolling]
  );

  // Listen for the cross-tab postMessage from the auth-complete page.
  useEffect(() => {
    if (step !== "oauth_callback") return;

    const handler = (_event: MessageEvent) => {
      void pollServerStatus(0);
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [step, serverName, pollServerStatus]);

  const handleOAuth = async () => {
    if (!authMeta?.authUrl) {
      setError("Server does not provide an OAuth authorization URL.");
      return;
    }

    setStep("oauth_authorizing");
    setBusy(true);
    busyRef.current = true;
    setError(null);
    consecutiveErrorsRef.current = 0;

    try {
      // Start the auth flow server-side — it discovers the OAuth metadata
      // and returns the authorization URL to redirect the user.
      const res = await fetch("/api/mcp/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverName,
          authUrl: authMeta.authUrl,
          scopes: authMeta.oauthScopes,
          redirectUri: `${window.location.origin}/api/mcp/auth/callback`,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        authUrl?: string;
        error?: string;
      } | null;
      if (!res.ok || !data?.authUrl) {
        throw new Error(data?.error ?? `Auth flow request failed: ${res.status}`);
      }

      // Open the authorization URL in a new tab.
      setStep("oauth_callback");
      const newTab = window.open(data.authUrl, "_blank", "noopener,noreferrer");
      if (!newTab) {
        setBusy(false);
        busyRef.current = false;
        setError("Could not open authorization URL. Check your popup blocker.");
        return;
      }

      // Poll for auth completion every 2 seconds.
      pollIntervalRef.current = setInterval(() => {
        void pollServerStatus(consecutiveErrorsRef.current);
      }, 2000);

      // Safety timeout: stop polling after 5 minutes.
      timeoutRef.current = setTimeout(() => {
        stopPolling();
        if (busyRef.current) {
          setBusy(false);
          busyRef.current = false;
          setStep("method");
          setError("OAuth flow timed out. Please try again.");
        }
      }, 5 * 60_000);
    } catch (err) {
      setBusy(false);
      busyRef.current = false;
      setError(
        err instanceof Error ? err.message : "Failed to start OAuth flow."
      );
      setStep("method");
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
    onAuthComplete({
      auth: {
        method: "api_key",
        status: "configured",
        apiKeyName: apiKeyName.trim(),
        lastAuthenticatedAt: Date.now(),
      },
      apiKey: apiKey.trim(),
      apiKeyName: apiKeyName.trim(),
    });
  };

  const handleNone = () => {
    onAuthComplete({
      auth: {
        method: "none",
        status: "configured",
      },
    });
  };

  const reset = () => {
    stopPolling();
    setStep("method");
    setApiKey("");
    setApiKeyName("");
    setError(null);
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
              disabled={!authMeta || authMeta.method !== "oauth" || busy}
            >
              <SealCheck className="size-4 mr-2" />
              OAuth (recommended)
            </Button>

            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => setStep("api_key")}
              disabled={
                !authMeta ||
                (authMeta.method !== "api_key" && authMeta.method !== "oauth") ||
                busy
              }
            >
              API key
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
                Header name
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

        {step === "oauth_callback" && (
          <div className="space-y-3 py-4 text-center">
            <div className="flex justify-center">
              <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
            <p className="text-sm">
              Complete authentication in the browser tab that opened.
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
