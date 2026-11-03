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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ProviderConfig } from "@/lib/settings";

export function ProviderEditDialog({
  open,
  onOpenChange,
  provider,
  name,
  baseUrl,
  apiKey,
  clearKey,
  error,
  busy,
  onNameChange,
  onBaseUrlChange,
  onApiKeyChange,
  onClearKeyChange,
  onCancel,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The provider being edited; null while the dialog is closing. */
  provider: ProviderConfig | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  clearKey: boolean;
  error: string | null;
  busy: boolean;
  onNameChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onClearKeyChange: (value: boolean) => void;
  /** Close without discarding the provider state (matches the Cancel button). */
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onOpenChange(false);
        }
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Provider</DialogTitle>
          <DialogDescription>
            Update provider details and credentials.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void onSave();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="edit-prov-name">Provider Name</FieldLabel>
              <Input
                id="edit-prov-name"
                onChange={(e) => onNameChange(e.target.value)}
                placeholder="Provider name"
                value={name}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="edit-prov-base-url">Base URL</FieldLabel>
              <Input
                id="edit-prov-base-url"
                onChange={(e) => onBaseUrlChange(e.target.value)}
                placeholder="https://api.openai.com/v1"
                required
                value={baseUrl}
              />
            </Field>

            {provider?.kind === "openai-compatible" && (
              <Field>
                <FieldLabel htmlFor="edit-prov-api-key">API Key</FieldLabel>
                <Input
                  disabled={clearKey}
                  id="edit-prov-api-key"
                  onChange={(e) => onApiKeyChange(e.target.value)}
                  placeholder={
                    provider.apiKeyConfigured
                      ? "•••••••• (leave blank to keep unchanged)"
                      : "Optional bearer token"
                  }
                  type="password"
                  value={apiKey}
                />
                <FieldDescription>
                  API keys are write-only and stored securely on the server.
                </FieldDescription>

                {provider.apiKeyConfigured && (
                  <div className="pt-2">
                    <Button
                      onClick={() => {
                        onClearKeyChange(!clearKey);
                        if (!clearKey) onApiKeyChange("");
                      }}
                      size="sm"
                      type="button"
                      variant={clearKey ? "destructive" : "outline"}
                    >
                      {clearKey ? "Keep existing key" : "Clear configured key"}
                    </Button>
                  </div>
                )}
              </Field>
            )}

            {error && (
              <p className="text-destructive text-xs">{error}</p>
            )}
          </FieldGroup>

          <DialogFooter className="mt-2">
            <Button
              onClick={() => onCancel()}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={busy || !baseUrl.trim()}
              type="submit"
            >
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
