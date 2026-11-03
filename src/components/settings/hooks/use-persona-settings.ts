"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_SYSTEM_PERSONA,
  type SystemPersonaConfig,
} from "@/lib/persona/types";

/**
 * Persona-tab state and handlers, owned by the settings shell.
 *
 * Tracks the custom system persona, default template, dirty status for
 * close-guard, and handles save/reset.
 *
 * See `docs/adr/2026-11-03-settings-view-tab-state-hooks.md`.
 */
export function usePersonaSettings({
  open,
  settingsVersion = 0,
}: {
  open: boolean;
  settingsVersion?: number;
}) {
  const [persona, setPersona] = useState<SystemPersonaConfig>(
    DEFAULT_SYSTEM_PERSONA
  );
  const [defaultPersona, setDefaultPersona] = useState<SystemPersonaConfig>(
    DEFAULT_SYSTEM_PERSONA
  );
  const [personaDirty, setPersonaDirty] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function fetchPersona() {
      try {
        const res = await fetch("/api/settings/persona");
        if (res.ok) {
          const data = (await res.json()) as {
            persona?: SystemPersonaConfig;
            defaultPersona?: SystemPersonaConfig;
          };
          if (!cancelled) {
            if (data.persona) setPersona(data.persona);
            if (data.defaultPersona) setDefaultPersona(data.defaultPersona);
          }
        }
      } catch (err) {
        console.warn("[settings-view] Failed to load persona settings:", err);
      }
    }

    void fetchPersona();

    return () => {
      cancelled = true;
    };
  }, [open, settingsVersion]);

  const handleSavePersona = async (data: {
    name: string;
    instructions: string;
  }) => {
    try {
      const res = await fetch("/api/settings/persona", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { persona?: SystemPersonaConfig };
      if (json.persona) setPersona(json.persona);
      return true;
    } catch (err) {
      console.debug(
        `[settings-view] Error: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  };

  const handleResetPersona = async () => {
    try {
      const res = await fetch("/api/settings/persona/reset", {
        method: "POST",
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { persona?: SystemPersonaConfig };
      if (json.persona) setPersona(json.persona);
      return true;
    } catch (err) {
      console.debug(
        `[settings-view] Error: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  };

  return {
    persona,
    defaultPersona,
    personaDirty,
    setPersonaDirty,
    handleSavePersona,
    handleResetPersona,
  };
}
