"use client";

import { useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createProviderId, type ProviderConfig, type ProviderWriteInput } from "@/lib/settings";
import { NIM_BASE_URL } from "@/lib/ai/provider-config/schema";

type KeyRow = { id: string; value: string; saved: boolean; configured: boolean };
function newKeyRow(): KeyRow {
  return { id: createProviderId("key"), value: "", saved: false, configured: false };
}

/** Mount for each editing session so closing discards write-only credentials. */
export function NimProviderDialog({ provider, onSave, onClose }: {
  provider?: ProviderConfig;
  onSave: (provider: ProviderWriteInput) => Promise<void>;
  onClose: () => void;
}) {
  const [id] = useState(() => provider?.id ?? createProviderId("nvidia-nim"));
  const [name, setName] = useState(provider?.name ?? "NVIDIA NIM");
  const [rows, setRows] = useState<KeyRow[]>(() => provider?.apiKeys?.length
    ? provider.apiKeys.map((row) => ({ id: row.id, value: "", saved: true, configured: row.configured }))
    : [newKeyRow()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = rows.length > 0 && rows.length <= 20 && rows.every((row) => row.saved || row.value.trim());

  async function save() {
    if (busy || !valid) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({
        ...provider,
        id,
        name: name.trim() || "NVIDIA NIM",
        kind: "openai-compatible",
        preset: "nvidia-nim",
        baseUrl: NIM_BASE_URL,
        models: provider?.models ?? [],
        apiKeys: rows.map((row) => ({ id: row.id, ...(row.value.trim() ? { value: row.value.trim() } : {}) })),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save provider");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{provider ? "Edit NVIDIA NIM" : "Add NVIDIA NIM"}</DialogTitle>
          <DialogDescription>Configure NVIDIA NIM credentials for the hosted API.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="nim-name">Provider Name</FieldLabel>
              <Input id="nim-name" value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="nim-base-url">Base URL</FieldLabel>
              <Input id="nim-base-url" value={NIM_BASE_URL} readOnly />
            </Field>
            <FieldDescription>
              Add 1–20 keys. Keys are stored server-side and never returned to the browser. Leave a saved row blank to keep it; type a new value to replace it.
            </FieldDescription>
            {rows.map((row, index) => (
              <Field key={row.id}>
                <FieldLabel htmlFor={`nim-key-${row.id}`}>API key {index + 1}</FieldLabel>
                <div className="flex items-center gap-2">
                  <Input
                    id={`nim-key-${row.id}`} type="password" autoComplete="new-password" disabled={busy}
                    value={row.value} placeholder={row.configured ? "Configured — leave blank to keep" : "Enter API key"}
                    onChange={(event) => setRows((current) => current.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))}
                  />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove API key ${index + 1}`}
                    disabled={busy || rows.length === 1} onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}>
                    <Trash className="size-4" />
                  </Button>
                </div>
                {row.saved && <FieldDescription>{row.configured ? "Configured" : "Not configured on server"}</FieldDescription>}
              </Field>
            ))}
            <Button type="button" variant="outline" disabled={busy || rows.length >= 20}
              onClick={() => setRows((current) => current.length < 20 ? [...current, newKeyRow()] : current)}>
              <Plus className="size-4" /> Add API key
            </Button>
            {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !valid}>{busy ? "Saving…" : provider ? "Save changes" : "Save provider"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
