"use client";

import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { Bell } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/** Shape of the notify_user tool output (server tool contract). */
type NotifyUserOutput = {
  delivered: boolean;
  timestamp?: number;
  title?: string;
  message?: string;
  level?: "info" | "success" | "warning" | "urgent";
  sound?: boolean;
  reason?: string;
};

type Level = NonNullable<NotifyUserOutput["level"]>;

const LEVEL_BADGES: Record<Level, string> = {
  info: "text-sky-600 dark:text-sky-400 bg-sky-500/10 border-sky-500/20",
  success:
    "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  warning:
    "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20",
  urgent: "text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/20",
};

/** Web Audio tones per level; the success level plays an arpeggio. */
const LEVEL_FREQUENCIES: Record<Level, number[]> = {
  info: [440],
  success: [523, 659],
  warning: [330],
  urgent: [220],
};

/**
 * Synthesizes the level chime with Web Audio. Guarded: environments without
 * AudioContext (SSR, jsdom, autoplay-blocked browsers) silently skip it —
 * the chime is a courtesy signal, never a load-bearing feature.
 */
function playChime(level: Level): void {
  try {
    const AudioCtx =
      typeof window === "undefined"
        ? undefined
        : window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const frequencies = LEVEL_FREQUENCIES[level];
    frequencies.forEach((freq, i) => {
      // Arpeggio notes start 120ms after the previous; a single tone plays now.
      const startAt = ctx.currentTime + i * 0.12;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      // Chime envelope: instant attack, ~0.3s exponential decay.
      gain.gain.setValueAtTime(0.001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.2, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + 0.35);
    });
    // Urgent pulses: three rapid repeats of the low tone.
    if (level === "urgent") {
      for (let pulse = 1; pulse <= 2; pulse++) {
        const startAt = ctx.currentTime + pulse * 0.25;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = LEVEL_FREQUENCIES.urgent[0];
        gain.gain.setValueAtTime(0.001, startAt);
        gain.gain.exponentialRampToValueAtTime(0.2, startAt + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startAt);
        osc.stop(startAt + 0.25);
      }
    }
  } catch {
    // Chime failure (autoplay policy, closed context) must never break chat rendering.
  }
}

/**
 * Dispatches a browser Notification when permission was already granted.
 * Never requests permission — prompting mid-conversation is intrusive.
 */
function showBrowserNotification(title: string, body: string): void {
  try {
    if (
      typeof window === "undefined" ||
      !("Notification" in window) ||
      window.Notification.permission !== "granted"
    ) {
      return;
    }
    new window.Notification(title, { body });
  } catch {
    // Notification dispatch failure (e.g. constructor disabled) is non-fatal.
  }
}

type NotifyReceiptProps = {
  part: ToolUIPart | DynamicToolUIPart;
};

/**
 * Delivery receipt card for a notify_user invocation: bell icon, title,
 * message, and level badge. When the server suppressed delivery
 * (rate limit / dedup), the reason is shown instead of the content.
 * Also fires the client-side chime + browser notification exactly once
 * per tool call id, guarded against StrictMode double-invocation.
 */
export function NotifyReceipt({ part }: NotifyReceiptProps) {
  const output = (part.state === "output-available" ? part.output : undefined) as
    | NotifyUserOutput
    | undefined;

  const toolCallId = part.toolCallId;
  const playedFor = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!output?.delivered) return;
    // A single notify part may re-render repeatedly during streaming; the
    // ref keyed on toolCallId guarantees the sound fires exactly once.
    if (playedFor.current.has(toolCallId)) return;
    playedFor.current.add(toolCallId);

    const level = output.level ?? "info";
    const inputTitle = (part.input as { title?: unknown } | undefined)?.title;
    const title = output.title ?? String(inputTitle ?? "Notification");
    const message = output.message ?? "";

    if (output.sound !== false) playChime(level);
    showBrowserNotification(title, message);
    // output identity changes per render; toolCallId is the stable key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolCallId, output?.delivered]);

  const level: Level = output?.level ?? "info";
  const title = output?.title ?? (part.input as { title?: string } | undefined)?.title ?? "Notification";
  const message =
    output?.message ?? (part.input as { message?: string } | undefined)?.message;

  return (
    <div className="flex w-full flex-col gap-2 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <Bell className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-sm">{title}</span>
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium select-none",
            LEVEL_BADGES[level]
          )}
        >
          {level}
        </span>
      </div>
      {output?.delivered ? (
        message ? <p className="text-sm text-muted-foreground">{message}</p> : null
      ) : (
        <p className="text-sm text-muted-foreground">
          Delivery suppressed: {output?.reason ?? "unknown reason"}
        </p>
      )}
    </div>
  );
}
