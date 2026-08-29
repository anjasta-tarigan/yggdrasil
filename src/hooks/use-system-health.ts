"use client";

import { useEffect, useState } from "react";

export type HealthStatus = "checking" | "ok" | "degraded" | "down";

export type SystemHealth = {
  status: HealthStatus;
  latencyMs?: number;
  modelId?: string;
  modelCount?: number;
  httpStatus?: number;
  checkedAt?: number;
  /** Server clock reference (ISO) — lets consumers detect browser skew. */
  serverNow?: string;
  /** Server timezone name, e.g. "Asia/Makassar". */
  serverTimezone?: string;
};

/**
 * Polls `/api/health` on an interval and returns the latest result.
 * This subscribes to an external system (network + timer) and cleans up
 * both on unmount, per React effect hygiene rules.
 */
export function useSystemHealth(intervalMs = 10000): SystemHealth {
  const [health, setHealth] = useState<SystemHealth>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      // Stamp BEFORE the fetch: checkedAt must bracket the server's clock
      // reading as tightly as possible. The health handler runs an LLM
      // /models probe (up to 5s) AFTER stamping serverTime.now — stamping
      // after the response would bias any skew math by the full probe
      // latency.
      const fetchedAt = Date.now();
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as Partial<SystemHealth> & {
          serverTime?: { now?: string; timezone?: string };
        };
        if (!cancelled) {
          setHealth({
            ...data,
            status: data.status ?? "down",
            // Map the route's nested serverTime{now,timezone} onto the flat
            // fields this hook's consumers (getClockSkewMs, StatusFooter)
            // read — the raw spread never populated them before.
            serverNow: data.serverTime?.now ?? data.serverNow,
            serverTimezone: data.serverTime?.timezone ?? data.serverTimezone,
            checkedAt: fetchedAt,
          });
        }
      } catch {
        if (!cancelled) {
          setHealth({ status: "down", checkedAt: fetchedAt });
        }
      }
    };

    void check();
    const timer = setInterval(() => void check(), intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
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