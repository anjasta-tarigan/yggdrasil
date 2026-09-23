"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { ExperimentalProviderBanner } from "./experimental-provider-banner";
import { WebProviderHelpPanel } from "./web-provider-help-panel";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  checkWebProviderSession,
  discoverWebProviderModels,
  saveWebProviderSession,
  type WebProviderUserAgentMode,
} from "@/lib/settings";

export const DEEPSEEK_WEB_PROVIDER_ID = "deepseek-web";

/** Spec §5.3: shown when a check is rejected or a save does not persist. */
const REJECTED_COPY =
  "The session was rejected. Your credentials were not saved.";

export type DeepSeekWebSaveOutcome = {
  /** Discovered model count after the one post-save discovery request. */
  discoveredModels: number | null;
  discoveryFailed: boolean;
  /**
   * Which action produced this outcome. A save and a refresh can both fail
   * discovery, but only the save has a session worth reporting as saved.
   */
  source: "save" | "refresh";
};

const USER_AGENT_MODES: Array<{
  value: WebProviderUserAgentMode;
  label: string;
}> = [
  { value: "browser", label: "Use this browser's User-Agent" },
  { value: "server-default", label: "Use Yggdrasil's default User-Agent" },
  { value: "custom", label: "Use a custom User-Agent (Advanced)" },
];

/**
 * DeepSeek Web session import (Spec §5, §10).
 *
 * Check and Save are separate: `Check connection` is side-effect-free and its
 * success is what unlocks `Save provider`. The token lives only in this
 * component's state — it is never written to browser storage (Spec §4.3).
 */
export function DeepSeekWebProviderDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (outcome: DeepSeekWebSaveOutcome) => void;
}) {
  const [userToken, setUserToken] = useState("");
  const [userAgentMode, setUserAgentMode] =
    useState<WebProviderUserAgentMode>("browser");
  const [capturedUserAgent, setCapturedUserAgent] = useState("");
  const [customUserAgent, setCustomUserAgent] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verified, setVerified] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedOutcome, setSavedOutcome] = useState<DeepSeekWebSaveOutcome | null>(
    null
  );
  // Spec §8.1 discovery states. `discoveredAt === null` means no discovery has
  // succeeded in this dialog session, which is what decides Discover vs Refresh.
  const [discoveredAt, setDiscoveredAt] = useState<number | null>(null);
  const [discoveredCount, setDiscoveredCount] = useState<number | null>(null);
  const [discoveryStale, setDiscoveryStale] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  // A first discovery failure has no last-known list to fall back on, so it
  // must say something rather than appearing to do nothing (Rule 02).
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Guards against an out-of-order check response overwriting newer state
  // (Rule 17). Only the newest request may flip `verified`.
  const checkSequence = useRef(0);

  // Spec §5.2: the User-Agent is read from the browser only, and only in a
  // client effect — never during SSR (a render-time read would hydrate
  // differently from the server's HTML).
  useEffect(() => {
    if (typeof window !== "undefined") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- navigator is browser-only; reading it during render would break hydration
      setCapturedUserAgent(window.navigator.userAgent);
    }
  }, []);

  function activeUserAgent(): string | undefined {
    if (userAgentMode === "browser") return capturedUserAgent || undefined;
    if (userAgentMode === "custom") return customUserAgent.trim() || undefined;
    return undefined;
  }

  function resetVerification() {
    checkSequence.current += 1;
    setVerified(false);
  }

  async function handleCheck() {
    if (checking || saving || !userToken.trim()) return;
    const sequence = ++checkSequence.current;
    setChecking(true);
    setError(null);
    try {
      const result = await checkWebProviderSession({
        providerId: DEEPSEEK_WEB_PROVIDER_ID,
        userToken,
        userAgentMode,
        userAgent: activeUserAgent(),
      });
      if (sequence !== checkSequence.current) return; // stale response
      if (result.ok) {
        setVerified(true);
      } else {
        setVerified(false);
        setError(result.message ?? REJECTED_COPY);
      }
    } catch {
      if (sequence !== checkSequence.current) return;
      setVerified(false);
      setError("DeepSeek Web could not be reached.");
    } finally {
      setChecking(false);
    }
  }

  async function runDiscovery(force: boolean): Promise<{
    discoveredModels: number | null;
    discoveryFailed: boolean;
  }> {
    setDiscovering(true);
    setDiscoveryError(null);
    let discoveredModels: number | null = null;
    let discoveryFailed = false;
    try {
      const discovery = await discoverWebProviderModels(
        DEEPSEEK_WEB_PROVIDER_ID,
        force
      );
      if (discovery.ok) {
        discoveredModels = discovery.models?.length ?? 0;
        setDiscoveredCount(discoveredModels);
        setDiscoveredAt(Date.now());
        setDiscoveryStale(false);
      } else {
        // Spec §8.1: a failed refresh keeps the last known list and labels it
        // stale rather than blanking the count.
        discoveryFailed = true;
        if (discoveredAt === null) {
          setDiscoveryError(
            discovery.message ?? "Model discovery failed. Try again later."
          );
        } else {
          setDiscoveryStale(true);
        }
      }
    } catch {
      discoveryFailed = true;
      if (discoveredAt === null) {
        setDiscoveryError("Model discovery failed. Try again later.");
      } else {
        setDiscoveryStale(true);
      }
    } finally {
      setDiscovering(false);
    }
    return { discoveredModels, discoveryFailed };
  }

  async function handleSave() {
    if (saving || checking || !verified) return;
    setSaving(true);
    setError(null);

    let result;
    try {
      result = await saveWebProviderSession({
        providerId: DEEPSEEK_WEB_PROVIDER_ID,
        userToken,
        userAgentMode,
        userAgent: activeUserAgent(),
      });
    } catch {
      setError("DeepSeek Web could not be reached.");
      setSaving(false);
      return;
    }

    if (!result.ok) {
      setError(result.message ?? REJECTED_COPY);
      setSaving(false);
      return;
    }

    // Spec §5.3: the secret is cleared from component state on success.
    setUserToken("");
    setVerified(false);
    setSaved(true);

    // Spec §8.1: exactly one discovery request, and only after a save. A
    // discovery failure does not fail the save — the session is stored and the
    // last known model list survives (Spec §8.1, §15.12).
    const outcome = await runDiscovery(true);
    setSavedOutcome({ ...outcome, source: "save" });
    setSaving(false);
    onSaved({ ...outcome, source: "save" });
  }

  async function handleRefresh() {
    if (discovering || saving) return;
    // Spec §8.1: refresh reuses the stored session; it never asks for a token.
    const outcome = await runDiscovery(true);
    setSavedOutcome({ ...outcome, source: "refresh" });
    onSaved({ ...outcome, source: "refresh" });
  }

  const tokenFieldId = "deepseek-web-token";
  const tokenErrorId = "deepseek-web-token-error";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>DeepSeek Web (experimental)</DialogTitle>
          <DialogDescription>
            Import a session credential from your own DeepSeek Web account. The
            credential is stored encrypted on the Yggdrasil server and is never
            returned to this browser.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <ExperimentalProviderBanner />

            <FieldGroup>
              <Field data-invalid={error !== null}>
                <div className="flex items-center justify-between gap-2">
                  <FieldLabel htmlFor={tokenFieldId}>Web session token</FieldLabel>
                  <Button
                    className="h-11 px-2 text-xs"
                    onClick={() => setShowHelp((current) => !current)}
                    size="xs"
                    type="button"
                    variant="link"
                  >
                    How to get this?
                  </Button>
                </div>
                <Input
                  aria-describedby={error ? tokenErrorId : undefined}
                  aria-invalid={error !== null}
                  autoComplete="off"
                  disabled={saving}
                  id={tokenFieldId}
                  onChange={(event) => {
                    setUserToken(event.target.value);
                    setError(null);
                    resetVerification();
                  }}
                  placeholder="userToken=… or raw session token"
                  type="password"
                  value={userToken}
                />
                <FieldDescription>
                  Stored encrypted server-side and never returned to the
                  browser. Check the connection before saving.
                </FieldDescription>
              </Field>

              <FieldSet>
                <FieldLegend variant="label">Request identity</FieldLegend>
                <div className="flex flex-col gap-2">
                  {USER_AGENT_MODES.map((mode) => (
                    <div className="flex flex-col gap-1.5" key={mode.value}>
                      {/* Spec §10.3: 44px minimum interactive target. The label
                          is the click target so the whole row is hittable. */}
                      <div
                        className="flex min-h-11 items-center gap-2"
                        data-testid={`ua-mode-row-${mode.value}`}
                      >
                        <input
                          checked={userAgentMode === mode.value}
                          className="size-3.5 accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                          disabled={saving}
                          id={`ua-mode-${mode.value}`}
                          name="deepseek-web-user-agent-mode"
                          onChange={() => {
                            setUserAgentMode(mode.value);
                            resetVerification();
                          }}
                          type="radio"
                          value={mode.value}
                        />
                        <label
                          className="flex min-h-11 flex-1 cursor-pointer items-center text-xs"
                          htmlFor={`ua-mode-${mode.value}`}
                        >
                          {mode.label}
                        </label>
                      </div>
                      {mode.value === "browser" &&
                        userAgentMode === "browser" && (
                          <Input
                            aria-label="Captured browser User-Agent"
                            className="bg-muted/30 font-mono text-[11px]"
                            readOnly
                            value={capturedUserAgent}
                          />
                        )}
                      {mode.value === "custom" && userAgentMode === "custom" && (
                        <Input
                          aria-label="Custom User-Agent"
                          className="font-mono text-xs"
                          disabled={saving}
                          onChange={(event) => {
                            setCustomUserAgent(event.target.value);
                            resetVerification();
                          }}
                          placeholder="Custom User-Agent string"
                          value={customUserAgent}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </FieldSet>

              {/* Spec §8.1: model discovery is an explicit action, never a
                  poll. Discover appears before the first successful discovery;
                  afterwards it becomes Refresh. */}
              <div className="flex flex-col gap-2 rounded-lg border p-3">
                <p className="font-medium text-xs">Models</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    className="h-11 px-3"
                    disabled={discovering || saving}
                    onClick={() => void handleRefresh()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {discovering
                      ? "Discovering models…"
                      : discoveredAt === null
                        ? "Discover models"
                        : "Refresh models"}
                  </Button>
                  {discoveredCount !== null && (
                    <span className="text-muted-foreground text-xs">
                      {discoveredCount}{" "}
                      {discoveredCount === 1 ? "model" : "models"} discovered
                    </span>
                  )}
                </div>
                {discoveredAt !== null && (
                  <p className="text-muted-foreground text-xs">
                    Last discovered {formatRelativeTime(discoveredAt)}
                  </p>
                )}
                {discoveryStale && (
                  <p className="text-amber-600 text-xs dark:text-amber-400">
                    Last known list
                  </p>
                )}
                {discoveryError && (
                  <p className="text-destructive text-xs" role="alert">
                    {discoveryError}
                  </p>
                )}
              </div>

              {/* Status region: polite announcements for the check/save result. */}
              <div aria-live="polite" className="min-h-4 text-xs">
                {(verified || saved) && (
                  <p className="text-emerald-600 dark:text-emerald-400">
                    Connection verified.
                  </p>
                )}
                {/* A save and a refresh can both end in a failed discovery, but
                    only a save has a session to report — and only a failure that
                    had a last-known list may claim one was kept (Spec §8.1). A
                    first failure is already named by the Models-panel alert. */}
                {savedOutcome?.source === "save" &&
                  savedOutcome.discoveryFailed && (
                    <p className="text-muted-foreground">
                      {discoveryStale
                        ? "The session was saved, but model discovery failed. The last known model list was kept."
                        : "The session was saved, but model discovery failed."}
                    </p>
                  )}
                {savedOutcome?.source === "refresh" && discoveryStale && (
                  <p className="text-muted-foreground">
                    Model discovery failed. The last known model list was kept.
                  </p>
                )}
                {savedOutcome &&
                  !savedOutcome.discoveryFailed &&
                  savedOutcome.discoveredModels === 0 && (
                    <p className="text-muted-foreground">
                      No models were discovered. Add models manually in the
                      Providers tab.
                    </p>
                  )}
              </div>
              {error && (
                <p className="text-destructive text-xs" id={tokenErrorId} role="alert">
                  {error}
                </p>
              )}
            </FieldGroup>
          </div>

          {showHelp && (
            <WebProviderHelpPanel onClose={() => setShowHelp(false)} />
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          {saved ? (
            <Button className="min-h-11" onClick={onClose} type="button">
              Done
            </Button>
          ) : (
            <>
              <Button
                className="min-h-11"
                disabled={checking || saving || !userToken.trim()}
                onClick={() => void handleCheck()}
                type="button"
                variant="outline"
              >
                {checking ? "Checking connection…" : "Check connection"}
              </Button>
              <div className="flex gap-2">
                <Button
                  className="min-h-11"
                  disabled={saving}
                  onClick={onClose}
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
                <Button
                  className="min-h-11"
                  disabled={saving || checking || !verified}
                  onClick={() => void handleSave()}
                  type="button"
                >
                  {saving ? "Saving…" : "Save provider"}
                </Button>
              </div>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
