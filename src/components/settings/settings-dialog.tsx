"use client";

import { SettingsView } from "@/components/settings-view";

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Renders the Settings panel as a modal overlay on top of the chat.
 * SettingsView owns the Dialog primitive so the close-guard logic
 * (rebuildBusy, isDirty, personaDirty) has direct access to its state.
 */
export function SettingsDialog({
  open,
  onOpenChange,
}: SettingsDialogProps) {
  return <SettingsView open={open} onOpenChange={onOpenChange} />;
}
