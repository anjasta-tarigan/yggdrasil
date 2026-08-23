"use client";

import { cn } from "@/lib/utils";
import type { StoredChat } from "@/lib/chat-storage";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ChatCircleText,
  Plus,
  SidebarSimple,
  Sparkle,
  Trash,
} from "@phosphor-icons/react";

type SidebarProps = {
  chats: StoredChat[];
  activeChatId: string | null;
  open: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
};

export function Sidebar({
  chats,
  activeChatId,
  open,
  onToggle,
  onSelect,
  onNewChat,
  onDeleteChat,
}: SidebarProps) {
  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r bg-muted/20 transition-[width] duration-200",
        open ? "w-64" : "w-0 overflow-hidden border-r-0"
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkle className="size-4 shrink-0 text-primary" weight="fill" />
          <span className="truncate text-sm font-semibold">Yggdrasil</span>
        </div>
        <Button
          aria-label="Collapse sidebar"
          onClick={onToggle}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <SidebarSimple className="size-4" />
        </Button>
      </div>

      <div className="p-2">
        <Button
          className="w-full justify-start gap-2"
          onClick={onNewChat}
          type="button"
          variant="outline"
        >
          <Plus className="size-4" />
          New chat
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 px-2 pb-2">
          {chats.length === 0 ? (
            <p className="px-2 py-4 text-center text-muted-foreground text-xs">
              No conversations yet
            </p>
          ) : (
            chats.map((chat) => {
              const isActive = chat.id === activeChatId;
              return (
                <div
                  className={cn(
                    "group relative flex items-center rounded-md",
                    isActive
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  )}
                  key={chat.id}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
                    onClick={() => onSelect(chat.id)}
                    type="button"
                  >
                    <ChatCircleText className="size-4 shrink-0" />
                    <span className="truncate">{chat.title}</span>
                  </button>
                  <Button
                    aria-label={`Delete ${chat.title}`}
                    className="absolute right-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteChat(chat.id);
                    }}
                    size="icon-xs"
                    type="button"
                    variant="ghost"
                  >
                    <Trash className="size-3.5" />
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
