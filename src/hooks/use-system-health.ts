"use client";

import { useEffect, useState } from "react";

export type HealthStatus = "checking" | "ok" | "degraded" | "down";

/**
 * Lifecycle of a lazy/local service (ONNX embedding & reranker sessions):
 *  - `running`  — a native session is loaded in memory and hot
 *  - `standby`  — a model file exists on disk but the session is evicted (loads on demand)
 *  - `unload`   — no model is available / service is disabled
 */
export type ServiceLifecycle = "running" | "standby" | "unload";

/**
 * Compact diagnostic summary for an auxiliary service surfaced in the mini
 * footer. Mirrors the lazy-load/on-demand lifecycle shared by the local ONNX
 * embedding and reranker sessions.
 */
export type ServiceHealth = {
  /** running / standby / unload — see `ServiceLifecycle`. */
  status: ServiceLifecycle;
  /** Configuring provider, e.g. "onnx", "openai-compatible", "ollama", "disabled". */
  provider: string;
  /** Display model (filename for onnx, model id for remote). */
  model: string | null;
  /** Whether the native session is hot in memory (onnx only). */
  loaded: boolean;
};

export type DatabaseSubsystemHealth = {
  status: "ok" | "degraded" | "down";
  latencyMs?: number;
  wal?: boolean;
  error?: string;
};

export type QueueSubsystemHealth = {
  status: "ok" | "degraded" | "down";
  running: boolean;
  pendingJobs?: number;
  failedJobs?: number;
};

export type DaemonSubsystemHealth = {
  status: "ok" | "degraded" | "down";
  running: boolean;
  armedSchedules?: number;
};

export type InternalSubsystemHealth = {
  database?: DatabaseSubsystemHealth;
  queue?: QueueSubsystemHealth;
  daemon?: DaemonSubsystemHealth;
};

export type SystemHealth = {
  status: HealthStatus;
  /** Client roundtrip or server internal latency */
  latencyMs?: number;
  uptimeSeconds?: number;
  memoryHeapMb?: number;
  version?: string;
  modelId?: string;
  modelCount?: number;
  httpStatus?: number;
  checkedAt?: number;
  /** Server clock reference (ISO) — lets consumers detect browser skew. */
  serverNow?: string;
  /** Server timezone name, e.g. "Asia/Makassar". */
  serverTimezone?: string;
  /** Auxiliary service lifecycle — only present once the first poll resolves. */
  services?: {
    embedding?: ServiceHealth;
    reranker?: ServiceHealth;
  };
  subsystems?: InternalSubsystemHealth;
  error?: string;
};

/**
 * Polls `/api/health` on an interval and returns the latest result.
 * Automatically pauses polling when the browser tab is hidden to conserve
 * client and server resources, resuming instantly on visibility change.
 */
export function useSystemHealth(intervalMs = 10000): SystemHealth {
  const [health, setHealth] = useState<SystemHealth>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;

    const check = async (force = false) => {
      // Pause polling if document is hidden to conserve resources
      if (!force && typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }

      const fetchStart = performance.now();
      const fetchedAt = Date.now();
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const roundTripMs = Math.round(performance.now() - fetchStart);
        const data = (await res.json()) as Partial<SystemHealth> & {
          serverTime?: { now?: string; timezone?: string };
        };
        if (!cancelled) {
          setHealth({
            ...data,
            status: data.status ?? (res.ok ? "ok" : "down"),
            // Use client-measured round-trip latency to the local server if none reported
            latencyMs: data.latencyMs ?? roundTripMs,
            serverNow: data.serverTime?.now ?? data.serverNow,
            serverTimezone: data.serverTime?.timezone ?? data.serverTimezone,
            checkedAt: fetchedAt,
          });
        }
      } catch (err) {
        console.debug(`[use-system-health] Error: ${err instanceof Error ? err.message : String(err)}`);
        if (!cancelled) {
          setHealth({ status: "down", checkedAt: fetchedAt });
        }
      }
    };

    // Initial check (forced)
    void check(true);

    const timer = setInterval(() => void check(false), intervalMs);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void check(true);
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      cancelled = true;
      clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, [intervalMs]);

  return health;
}

/**
 * Approximate browser↔server clock skew in milliseconds (positive = the
 * server clock is ahead of the browser). Sub-second values are normal
 * network latency; more than a few seconds means one clock is wrong.
 */
export function getClockSkewMs(health: SystemHealth): number | null {
  if (!health.serverNow || !health.checkedAt) return null;
  const server = new Date(health.serverNow).getTime();
  if (Number.isNaN(server)) return null;
  return server - health.checkedAt;
}
