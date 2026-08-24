"use client";

import { Monitor, Moon, Sun } from "@phosphor-icons/react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

/**
 * Light / Dark / System theme switch for the header.
 *
 * Rendered as a segmented switch: one sliding thumb across three icon
 * positions (sun / monitor / moon). Keeps all three modes reachable,
 * including "follow the device".
 *
 * Like the previous dropdown, the control renders identically on server
 * and first client render (next-themes reports no choice yet -> system),
 * so there is no hydration mismatch; the highlight settles once the
 * stored preference is read after mount.
 */

const SEGMENT_SIZE = 26;

const THEME_OPTIONS = [
  { Icon: Sun, label: "Light theme", value: "light" },
  { Icon: Monitor, label: "Follow system theme", value: "system" },
  { Icon: Moon, label: "Dark theme", value: "dark" },
] as const;

export function ThemeToggle() {
  const { setTheme, theme } = useTheme();
  const current = theme ?? "system";
  const currentIndex = THEME_OPTIONS.findIndex((o) => o.value === current);

  return (
    <div
      aria-label="Theme"
      className="relative flex items-center rounded-full border bg-muted p-0.5"
      role="group"
    >
      {/* Sliding thumb behind the active icon */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-0.5 rounded-full bg-background shadow-sm",
          "transition-transform duration-200"
        )}
        style={{
          height: SEGMENT_SIZE,
          left: 2,
          transform: `translateX(${Math.max(currentIndex, 0) * SEGMENT_SIZE}px)`,
          width: SEGMENT_SIZE,
        }}
      />
      {THEME_OPTIONS.map(({ Icon, label, value }) => {
        const active = current === value;
        return (
          <button
            aria-label={label}
            aria-pressed={active}
            className={cn(
              "relative z-10 flex items-center justify-center rounded-full outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              active ? "text-foreground" : "text-muted-foreground"
            )}
            key={value}
            onClick={() => setTheme(value)}
            style={{ height: SEGMENT_SIZE, width: SEGMENT_SIZE }}
            type="button"
          >
            <Icon className="size-3.5" weight={active ? "fill" : "regular"} />
          </button>
        );
      })}
    </div>
  );
}
