"use client";

import { useState } from "react";
import { MAINTENANCE_LABELS, type DatabaseDiagnostics } from "@/components/settings/shared";

/**
 * Database-tab maintenance state and handlers, owned by the settings shell.
 *
 * Covers the manual cognitive passes (light sleep / dream cycle / decay sweep),
 * the embedding backfill, storage maintenance (optimize / VACUUM / reset), and
 * diagnostics. The note is returned as a setter because the embedding hook
 * reports an index rebuild outcome in the same banner.
 *
 * See `docs/adr/2026-11-03-settings-view-tab-state-hooks.md`.
 */
export function useDatabaseMaintenance({
  onRefresh,
}: {
  /** Bump the shell's snapshot version so counters re-read. */
  onRefresh: () => void;
}) {
  // Manual cognitive maintenance triggers (Database tab).
  const [maintenanceBusy, setMaintenanceBusy] = useState<string | null>(null);
  const [maintenanceNote, setMaintenanceNote] = useState<string | null>(null);

  async function runMaintenancePass(
    pass: "light_sleep" | "dream_cycle" | "decay_sweep"
  ) {
    setMaintenanceBusy(pass);
    setMaintenanceNote(null);
    try {
      const res = await fetch("/api/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pass }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setMaintenanceNote(
        `${MAINTENANCE_LABELS[pass]} queued — it runs as soon as the job queue is free.`
      );
      // Refresh stats shortly after so queue counters catch up.
      setTimeout(() => onRefresh(), 1500);
    } catch (err) {
      console.debug(`[settings-view] Error: ${err instanceof Error ? err.message : String(err)}`);
      setMaintenanceNote("Could not queue the maintenance pass.");
    } finally {
      setMaintenanceBusy(null);
    }
  }

  async function runEmbeddingBackfillNow() {
    setMaintenanceBusy("backfill");
    setMaintenanceNote(null);
    try {
      const res = await fetch("/api/maintenance/backfill", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        embeddedCount?: number;
        remaining?: number;
      };
      setMaintenanceNote(
        `Backfill embedded ${data.embeddedCount ?? 0} memories; ${data.remaining ?? 0} still pending.`
      );
      onRefresh();
    } catch (err) {
      console.debug(`[settings-view] Error: ${err instanceof Error ? err.message : String(err)}`);
      setMaintenanceNote("Embedding backfill failed.");
    } finally {
      setMaintenanceBusy(null);
    }
  }

  // Database storage maintenance (Database tab): optimize, VACUUM, reset,
  // and diagnostics. Separate busy/note state from the cognitive passes
  // above so the two groups never block each other.
  const [dbBusy, setDbBusy] = useState<string | null>(null);
  const [dbNote, setDbNote] = useState<string | null>(null);
  const [dbNoteKind, setDbNoteKind] = useState<
    "storage" | "reset" | null
  >(null);
  const [diagnostics, setDiagnostics] = useState<DatabaseDiagnostics | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);

  async function optimizeDatabase(includeVacuum: boolean) {
    setDbBusy(includeVacuum ? "vacuum" : "optimize");
    setDbNote(null);
    setDbNoteKind("storage");
    try {
      const res = await fetch("/api/maintenance/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vacuum: includeVacuum }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
        vacuum?: { recoveredBytes?: number };
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setDbNote(
        data.message ??
          (includeVacuum ? "Optimized and vacuumed." : "Query planner optimized.")
      );
      // Only VACUUM changes displayed stats (sizeBytes); a planner-only
      // optimize touches no settings data, so skip the snapshot re-fetch.
      if (includeVacuum) onRefresh();
    } catch (err) {
      console.debug(`[settings-view] Error: ${err instanceof Error ? err.message : String(err)}`);
      setDbNote(
        `Storage optimization failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setDbBusy(null);
    }
  }

  async function resetDatabaseNow() {
    setDbBusy("reset");
    setDbNote(null);
    setDbNoteKind("reset");
    try {
      const res = await fetch("/api/maintenance/reset", { method: "POST" });
      const data = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setDbNote(
          res.status === 409
            ? "Database is busy — try again in a few seconds."
            : `Reset failed: ${data.error ?? res.status}`
        );
        return;
      }
      setDbNote(data.message ?? "Database reset.");
      setDiagnostics(null);
      onRefresh();
    } catch (err) {
      console.debug(`[settings-view] Error: ${err instanceof Error ? err.message : String(err)}`);
      setDbNote("Database reset failed.");
    } finally {
      setDbBusy(null);
    }
  }

  async function refreshDiagnostics() {
    setDiagnosticsBusy(true);
    try {
      const res = await fetch("/api/maintenance/diagnostics");
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        ok?: boolean;
      } & DatabaseDiagnostics;
      if (!data.ok) throw new Error("diagnostics failed");
      setDiagnostics({
        metrics: data.metrics,
        slowOperations: data.slowOperations,
      });
    } catch (err) {
      console.debug(`[settings-view] Error: ${err instanceof Error ? err.message : String(err)}`);
      setDiagnostics(null);
    } finally {
      setDiagnosticsBusy(false);
    }
  }

  return {
    maintenanceBusy,
    maintenanceNote,
    setMaintenanceNote,
    runMaintenancePass,
    runEmbeddingBackfillNow,
    dbBusy,
    dbNote,
    dbNoteKind,
    optimizeDatabase,
    resetDatabaseNow,
    diagnostics,
    diagnosticsBusy,
    refreshDiagnostics,
  };
}
