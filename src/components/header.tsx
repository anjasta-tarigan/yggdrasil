"use client";

import { SidebarSimple } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { EventsInbox } from "@/components/events-inbox";
import { useProactiveEvents } from "@/hooks/use-proactive-events";

type HeaderProps = {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  chatTitle: string | null;
};

export function Header({
  sidebarOpen,
  onToggleSidebar,
  chatTitle,
}: HeaderProps) {
  const { events, unreadCount, markRead, markAllRead } = useProactiveEvents();

  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
      <div className="flex min-w-0 items-center gap-2">
        {!sidebarOpen && (
          <Button
            aria-label="Open sidebar"
            // Below md the sidebar is fully hidden, so this is the only way
            // back in. At md+ the collapsed sidebar is a visible icon rail
            // with its own expand control — a second toggle would be noise.
            className="md:hidden"
            onClick={onToggleSidebar}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <SidebarSimple className="size-4" />
          </Button>
        )}
        <h1 className="truncate text-sm font-medium">
          {chatTitle ?? "New chat"}
        </h1>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <EventsInbox
          events={events}
          unreadCount={unreadCount}
          onMarkRead={markRead}
          onMarkAllRead={markAllRead}
        />
        <ThemeToggle />
      </div>
    </header>
  );
}
