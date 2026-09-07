import { tool } from "ai";
import { z } from "zod";

/**
 * Multi-channel alerting. The tool returns a delivery record; the client
 * renders it as a browser Notification + desktop toast (Task 6 UI card).
 * Module-level state intentionally in-process: rate limiting and dedup
 * are enforced per server process (fails safe by over-blocking across
 * chats in the same process), not persisted.
 */

const WINDOW_MS = 60 * 1000;
const MAX_NOTIFICATIONS_PER_WINDOW = 5;
const DEDUP_WINDOW_MS = 10 * 1000;

let notificationTimestamps: number[] = [];
let lastNotification: { title: string; message: string; timestamp: number } | null = null;

export function resetNotificationRateLimit() {
  notificationTimestamps = [];
  lastNotification = null;
}

export const notify_user = tool({
  description:
    "Send an active notification to the user across browser and desktop channels. Useful for alerting when long-running tasks, code executions, or background operations complete, or when urgent input is needed. Rate-limited to max 5 per minute with duplicate suppression.",
  inputSchema: z.object({
    title: z.string().min(1).max(100).describe("Brief notification title"),
    message: z.string().min(1).max(500).describe("Descriptive notification content"),
    level: z
      .enum(["info", "success", "warning", "urgent"])
      .default("info")
      .describe("Severity level"),
    sound: z.boolean().default(true).describe("Whether to play an audible chime on client"),
  }),
  execute: async ({ title, message, level, sound }) => {
    const now = Date.now();

    if (
      lastNotification &&
      lastNotification.title === title &&
      lastNotification.message === message &&
      now - lastNotification.timestamp < DEDUP_WINDOW_MS
    ) {
      return { delivered: false, reason: "Duplicate suppressed (sent within 10s)" };
    }

    notificationTimestamps = notificationTimestamps.filter((t) => now - t < WINDOW_MS);
    if (notificationTimestamps.length >= MAX_NOTIFICATIONS_PER_WINDOW) {
      return { delivered: false, reason: "Rate limit exceeded (max 5/min)" };
    }

    notificationTimestamps.push(now);
    lastNotification = { title, message, timestamp: now };

    return {
      delivered: true,
      timestamp: now,
      title,
      message,
      level,
      sound,
    };
  },
});
