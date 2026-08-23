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
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as Partial<SystemHealth>;
        if (!cancelled) {
          setHealth({
            ...data,
            status: data.status ?? "down",
            checkedAt: Date.now(),
          });
        }
      } catch {
        if (!cancelled) {
          setHealth({ status: "down", checkedAt: Date.now() });
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
