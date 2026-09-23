"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { UserCircle, Check, ArrowCounterClockwise } from "@phosphor-icons/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { estimateTokens } from "@/lib/ai/context-budget";
import type { SystemPersonaConfig } from "@/lib/persona/types";

export interface PersonaTabProps {
  persona: SystemPersonaConfig;
  defaultPersona: SystemPersonaConfig;
  onSave: (data: { name: string; instructions: string }) => Promise<boolean>;
  onReset: () => Promise<boolean>;
}

export function PersonaTab({
  persona,
  defaultPersona,
  onSave,
  onReset,
}: PersonaTabProps) {
  const [name, setName] = useState(persona.name ?? "");
  const [instructions, setInstructions] = useState(persona.instructions ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const saveSuccessTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (saveSuccessTimeoutRef.current) {
        clearTimeout(saveSuccessTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setName(persona.name ?? "");
    setInstructions(persona.instructions ?? "");
  }, [persona]);

  const estimatedTokens = useMemo(() => {
    return estimateTokens(instructions.length);
  }, [instructions]);

  const isCustom = useMemo(() => {
    const trimmedInstructions = instructions.trim();
    const defaultTrimmed = defaultPersona.instructions.trim();
    return (
      (trimmedInstructions.length > 0 && trimmedInstructions !== defaultTrimmed) ||
      (name.trim().length > 0 && name.trim() !== defaultPersona.name)
    );
  }, [name, instructions, defaultPersona]);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveSuccess(false);
    if (saveSuccessTimeoutRef.current) {
      clearTimeout(saveSuccessTimeoutRef.current);
      saveSuccessTimeoutRef.current = null;
    }
    try {
      const ok = await onSave({ name: name.trim(), instructions: instructions });
      if (ok) {
        setSaveSuccess(true);
        saveSuccessTimeoutRef.current = setTimeout(() => {
          setSaveSuccess(false);
          saveSuccessTimeoutRef.current = null;
        }, 2500);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    // The reset discards a user-edited name and up to 10,000 chars of custom
    // instructions with no recovery, so gate it behind a confirm dialog.
    setConfirmResetOpen(false);
    setIsResetting(true);
    try {
      const ok = await onReset();
      if (ok) {
        setName(defaultPersona.name ?? "");
        setInstructions(defaultPersona.instructions);
      }
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <UserCircle className="size-5 text-muted-foreground" />
            <CardTitle>System Persona</CardTitle>
          </div>
          <Badge variant={isCustom ? "default" : "secondary"}>
            {isCustom ? "Custom Active" : "Default Yggdrasil"}
          </Badge>
        </div>
        <CardDescription>
          Customize your AI&apos;s global identity, tone, and behavioral instructions across all conversations.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="persona-name">Persona Name (Optional)</FieldLabel>
            <Input
              id="persona-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Software Architect, Senior Researcher, or Yggdrasil"
              maxLength={100}
            />
            <FieldDescription>
              A descriptive title or name the assistant identifies as. Defaults to &quot;Yggdrasil&quot;.
            </FieldDescription>
          </Field>

          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="persona-instructions">System Instructions</FieldLabel>
              <Badge variant="outline" className="text-xs font-mono">
                ~{estimatedTokens} tokens
              </Badge>
            </div>
            <Textarea
              id="persona-instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={defaultPersona.instructions}
              rows={8}
              className="font-mono text-sm leading-relaxed"
              maxLength={10000}
            />
            <FieldDescription>
              Instructions defining the assistant&apos;s personality, expertise, formatting habits, or domain focus.
              Core tool invariants (web search, artifacts, tasks) strictly apply regardless of persona.
            </FieldDescription>
          </Field>
        </FieldGroup>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={handleSave}
              disabled={isSaving || isResetting}
            >
              {saveSuccess ? (
                <>
                  <Check className="size-4 text-success" />
                  Saved
                </>
              ) : (
                "Save Persona"
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmResetOpen(true)}
              disabled={isSaving || isResetting}
            >
              <ArrowCounterClockwise className="size-4" />
              Reset to Default
            </Button>
          </div>
          <span className="text-muted-foreground text-xs">
            Max 10,000 characters (~2,500 tokens)
          </span>
        </div>
      </CardContent>
      <ConfirmDialog
        open={confirmResetOpen}
        onOpenChange={setConfirmResetOpen}
        title="Reset to default persona?"
        description="This discards your custom name and instructions and restores the Yggdrasil default."
        confirmLabel="Reset to Default"
        busy={isResetting}
        onConfirm={handleReset}
      />
    </Card>
  );
}
