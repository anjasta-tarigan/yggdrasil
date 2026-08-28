"use client";

import { useCallback, useEffect, useState } from "react";

export interface ProactiveEvent {
  id: string;
  kind: "reminder" | "system";
  title: string;
  body: string | null;
  chatId: string | null;
  createdAt: string | number | Date;
}

const POLL_INTERVAL_MS = 30_000;

/**
 * Polls `/api/events` for unread proactive events (reminders fired by the
 * background queue) and exposes mark-read actions for the header inbox.
 * Subscribes to network + timer and cleans both up on unmount, matching
 * the useSystemHealth polling pattern.
 */
export function useProactiveEvents() {
  const [events, setEvents] = useState<ProactiveEvent[]>([]);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch("/api/events", { cache: "no-store" });
        if (!res.ok) {
          console.warn(`[useProactiveEvents] Poll returned status ${res.status}`);
          return;
        }
        const data = (await res.json()) as { events?: ProactiveEvent[] };
        if (!cancelled && Array.isArray(data.events)) {
          setEvents(data.events);
        }
      } catch (err) {
        console.warn("[useProactiveEvents] Polling failed:", err);
      }
    };

    void check();
    const timer = setInterval(() => void check(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const markRead = useCallback(async (id: string) => {
    // Optimistic removal; the next poll reconciles if the call failed.
    setEvents((prev) => prev.filter((e) => e.id !== id));
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(id)}/read`, {
        method: "POST",
      });
      if (!res.ok) {
        console.warn(`[useProactiveEvents] markRead returned status ${res.status}`);
      }
    } catch (err) {
      console.warn("[useProactiveEvents] markRead failed:", err);
    }
  }, []);

  const markAllRead = useCallback(async () => {
    setEvents([]);
    try {
      const res = await fetch("/api/events", { method: "POST" });
      if (!res.ok) {
        console.warn(`[useProactiveEvents] markAllRead returned status ${res.status}`);
      }
    } catch (err) {
      console.warn("[useProactiveEvents] markAllRead failed:", err);
    }
  }, []);

  return { events, unreadCount: events.length, markRead, markAllRead };
}
