"use client";

import { Bell, BellSimple, CheckCircle, Trash } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ProactiveEvent } from "@/hooks/use-proactive-events";

type EventsInboxProps = {
  events: ProactiveEvent[];
  unreadCount: number;
  onMarkRead: (id: string) => void | Promise<void>;
  onMarkAllRead: () => void | Promise<void>;
};

function formatWhen(createdAt: ProactiveEvent["createdAt"]): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Header inbox for proactive events (reminders the assistant scheduled
 * via the background queue). Unread count shows as a badge; the popover
 * lists events with per-item and bulk dismiss.
 */
export function EventsInbox({
  events,
  unreadCount,
  onMarkRead,
  onMarkAllRead,
}: EventsInboxProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label={`Proactive events (${unreadCount} unread)`}
          className="relative"
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {unreadCount > 0 ? (
            <BellSimple className="size-4" weight="fill" />
          ) : (
            <Bell className="size-4" />
          )}
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <p className="text-sm font-medium">Notifications</p>
          {unreadCount > 0 && (
            <Button
              onClick={() => void onMarkAllRead()}
              size="sm"
              type="button"
              variant="ghost"
            >
              <CheckCircle className="mr-1 size-3.5" />
              Mark all read
            </Button>
          )}
        </div>
        {events.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            Nothing here. Reminders you ask for will appear in this inbox.
          </p>
        ) : (
          <ul className="max-h-80 overflow-y-auto">
            {events.map((event) => (
              <li
                className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0"
                key={event.id}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{event.title}</p>
                  {event.body && (
                    <p className="line-clamp-3 text-xs text-muted-foreground">
                      {event.body}
                    </p>
                  )}
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {formatWhen(event.createdAt)}
                  </p>
                </div>
                <Button
                  aria-label="Dismiss"
                  onClick={() => void onMarkRead(event.id)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
