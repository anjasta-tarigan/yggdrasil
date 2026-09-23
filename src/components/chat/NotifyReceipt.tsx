"use client";

import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { Bell } from "@phosphor-icons/react";
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
  info: "text-primary bg-primary/10 border-primary/20",
  success: "text-success bg-success/10 border-success/20",
  warning: "text-warning bg-warning/10 border-warning/20",
  urgent: "text-destructive bg-destructive/10 border-destructive/20",
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
    // Latest scheduled stop, relative to now — the context closes after this + buffer.
    let lastEnd = 0;

    const scheduleTone = (freq: number, delaySec: number, durationSec: number) => {
      const startAt = ctx.currentTime + delaySec;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      // Chime envelope: instant attack, exponential decay.
      gain.gain.setValueAtTime(0.001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.2, startAt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, startAt + durationSec - 0.05);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + durationSec);
      lastEnd = Math.max(lastEnd, delaySec + durationSec);
    };

    // Arpeggio notes start 120ms after the previous; a single tone plays now.
    LEVEL_FREQUENCIES[level].forEach((freq, i) => scheduleTone(freq, i * 0.12, 0.35));
    // Urgent pulses: two rapid repeats of the low tone.
    if (level === "urgent") {
      scheduleTone(LEVEL_FREQUENCIES.urgent[0], 0.25, 0.25);
      scheduleTone(LEVEL_FREQUENCIES.urgent[0], 0.5, 0.25);
    }

    // Release the context — browsers cap concurrent AudioContexts (~6),
    // after which new chimes go silent.
    setTimeout(() => {
      try {
        ctx.close().catch(() => {
          // Context already closed or closing; nothing to release.
        });
      } catch {
        // Non-standard context without a close path; nothing to release.
      }
    }, Math.ceil((lastEnd + 0.3) * 1000));
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
 * (rate limit / dedup), the suppression reason is shown alongside the
 * requested content. Also fires the client-side chime + browser
 * notification exactly once per tool call id, guarded against
 * StrictMode double-invocation.
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
    const input = part.input as { title?: unknown; message?: unknown } | undefined;
    const title = output.title ?? String(input?.title ?? "Notification");
    const message = output.message ?? String(input?.message ?? "");

    if (output.sound !== false) playChime(level);
    showBrowserNotification(title, message);
    // output identity changes per render; toolCallId is the stable key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolCallId, output?.delivered]);

  const input = part.input as { title?: string; message?: string; level?: Level } | undefined;
  const level: Level = output?.level ?? input?.level ?? "info";
  const title = output?.title ?? input?.title ?? "Notification";
  const message = output?.message ?? input?.message;

  // output === undefined: the server has not decided delivery yet (part still
  // input-available / streaming) — render the requested receipt, no verdict line.
  const suppressionReason =
    output && !output.delivered ? output.reason ?? "unknown reason" : undefined;

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
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      {suppressionReason !== undefined && (
        <p className="text-sm text-muted-foreground">
          Delivery suppressed: {suppressionReason}
        </p>
      )}
    </div>
  );
}
