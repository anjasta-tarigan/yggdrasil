"use client";

import { SidebarSimple } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";

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
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
      <div className="flex min-w-0 items-center gap-2">
        {!sidebarOpen && (
          <Button
            aria-label="Open sidebar"
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
        <ThemeToggle />
      </div>
    </header>
  );
}
