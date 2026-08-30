"use client";

import { cn } from "@/lib/utils";
import type { StoredChat } from "@/lib/chat-storage";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEffect, useRef, useState } from "react";
import {
  ChartBar,
  ChatCircle,
  ChatCircleText,
  Clock,
  Robot,
  DotsThreeVertical,
  GearSix,
  PencilSimple,
  PlugsConnected,
  Plus,
  PushPin,
  PushPinSlash,
  PuzzlePiece,
  SidebarSimple,
  Sparkle,
  Trash,
} from "@phosphor-icons/react";

type SidebarProps = {
  chats: StoredChat[];
  activeChatId: string | null;
  open: boolean;
  /** True while the in-shell Chat view is shown. */
  chatActive?: boolean;
  /** True while the in-shell Cron Jobs page is shown. */
  cronActive?: boolean;
  /** True while the in-shell Subagents page is shown. */
  subagentsActive?: boolean;
  /** True while the in-shell Settings view is shown. */
  settingsActive: boolean;
  /** True while the in-shell MCP page is shown. */
  mcpActive: boolean;
  /** True while the in-shell Skills page is shown. */
  skillsActive: boolean;
  /** True while the in-shell Plugins page is shown. */
  pluginsActive: boolean;
  /** True while the in-shell Statistics page is shown. */
  statisticsActive: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onOpenChat?: () => void;
  onOpenCron?: () => void;
  onOpenSubagents?: () => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, title: string) => void;
  onTogglePinChat: (id: string) => void;
  onOpenSettings: () => void;
  onOpenMcp: () => void;
  onOpenSkills: () => void;
  onOpenPlugins: () => void;
  onOpenStatistics: () => void;
};

/** History time-range filter options ("1m/1d/7d/…" from the spec). */
const RANGES = [
  { key: "all", label: "All", days: null },
  { key: "1d", label: "1d", days: 1 },
  { key: "7d", label: "7d", days: 7 },
  { key: "1m", label: "1m", days: 30 },
  { key: "3m", label: "3m", days: 90 },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

export function Sidebar({
  chats,
  activeChatId,
  open,
  chatActive = true,
  cronActive = false,
  subagentsActive = false,
  settingsActive,
  mcpActive,
  skillsActive,
  pluginsActive,
  statisticsActive,
  onToggle,
  onSelect,
  onNewChat,
  onOpenChat,
  onOpenCron,
  onOpenSubagents,
  onDeleteChat,
  onRenameChat,
  onTogglePinChat,
  onOpenSettings,
  onOpenMcp,
  onOpenSkills,
  onOpenPlugins,
  onOpenStatistics,
}: SidebarProps) {
  const [range, setRange] = useState<RangeKey>("all");
  // Cutoff timestamp captured when the filter is chosen (Date.now() is
  // impure and may only run inside event handlers, not during render).
  const [cutoff, setCutoff] = useState<number | null>(null);
  const [menuForId, setMenuForId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // ---- Section 2 data: pinned group + time-filtered recents ----
  const pinnedChats = chats.filter((c) => c.pinned);
  const recentChats = chats.filter(
    (c) => !c.pinned && (cutoff == null || c.updatedAt >= cutoff)
  );

  const isCancellingRef = useRef(false);

  const startRename = (chat: StoredChat) => {
    isCancellingRef.current = false;
    setRenamingId(chat.id);
    setRenameDraft(chat.title);
    setMenuForId(null);
  };

  const commitRename = () => {
    if (isCancellingRef.current) {
      isCancellingRef.current = false;
      return;
    }
    if (renamingId && renameDraft.trim()) {
      onRenameChat(renamingId, renameDraft);
    }
    setRenamingId(null);
  };

  const cancelRename = () => {
    isCancellingRef.current = true;
    setRenamingId(null);
  };

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r bg-muted/20 transition-[width] duration-200",
        open ? "w-64" : "w-0 overflow-hidden border-r-0"
      )}
    >
      {/* ── Section 1 · Main menu ─────────────────────────────── */}
      <div className="shrink-0 border-b">
        <div className="flex items-center justify-between gap-2 px-3 py-3">
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
        <div className="flex flex-col gap-1 px-2 pb-2">
          <Button
            className="w-full justify-start gap-2"
            onClick={onNewChat}
            type="button"
            variant="outline"
          >
            <Plus className="size-4" />
            New chat
          </Button>
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              chatActive
                ? "bg-muted text-foreground font-medium"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
            onClick={onOpenChat ?? onNewChat}
            type="button"
          >
            <ChatCircle className="size-4" />
            Chat
          </button>
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              cronActive
                ? "bg-muted text-foreground font-medium"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
            onClick={onOpenCron}
            type="button"
          >
            <Clock className="size-4" />
            Cron Job
          </button>
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              subagentsActive
                ? "bg-muted text-foreground font-medium"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            )}
            onClick={onOpenSubagents}
            type="button"
          >
            <Robot className="size-4" />
            Subagents
          </button>
        </div>
      </div>

      {/* ── Section 2 · Chat history ──────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between px-3 pt-3 pb-1.5">
          <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            History
          </span>
          <div
            aria-label="Filter history by time range"
            className="flex items-center gap-0.5 rounded-md border bg-background p-0.5"
          >
            {RANGES.map((r) => (
              <button
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                  range === r.key
                    ? "bg-muted font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
                key={r.key}
                onClick={() => {
                  setRange(r.key);
                  setCutoff(
                    r.days == null
                      ? null
                      : Date.now() - r.days * 24 * 60 * 60 * 1000
                  );
                }}
                type="button"
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* The `[&_[data-slot=scroll-area-viewport]>div]:!block` override is
            load-bearing: Radix wraps viewport content in a
            `display: table; min-width: 100%` div. A CSS table sizes to its
            content's min-content width, and a `truncate` title
            (white-space: nowrap) makes that the full unwrapped text — so a
            long title blows the row out to max-content and pushes the ⋯
            trigger off-screen (measured: 1092px inside a 255px viewport).
            `width: 100%` cannot fix this: a table never shrinks below its
            min-content. Overriding the wrapper to `display: block` lets the
            inner flex column constrain and re-engages truncation. */}
        <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="flex flex-col gap-0.5 px-2 pb-2">
            {pinnedChats.length > 0 && (
              <>
                <span className="px-2 pt-1 pb-0.5 text-[10px] text-muted-foreground uppercase tracking-wide">
                  Pinned
                </span>
                {pinnedChats.map((chat) => (
                  <ChatRow
                    activeChatId={activeChatId}
                    chat={chat}
                    key={chat.id}
                    menuOpen={menuForId === chat.id}
                    onDelete={onDeleteChat}
                    onMenuOpenChange={(next) => setMenuForId(next ? chat.id : null)}
                    onRename={startRename}
                    onTogglePin={onTogglePinChat}
                    onSelect={onSelect}
                    renaming={renamingId === chat.id}
                    renameDraft={renameDraft}
                    onRenameDraftChange={setRenameDraft}
                    onCommitRename={commitRename}
                    onCancelRename={cancelRename}
                  />
                ))}
                <div className="my-1 border-b" />
              </>
            )}

            {recentChats.length === 0 && pinnedChats.length === 0 ? (
              <p className="px-2 py-4 text-center text-muted-foreground text-xs">
                No conversations yet
              </p>
            ) : recentChats.length === 0 ? (
              <p className="px-2 py-3 text-center text-muted-foreground text-xs">
                Nothing in this range
              </p>
            ) : (
              recentChats.map((chat) => (
                <ChatRow
                  activeChatId={activeChatId}
                  chat={chat}
                  key={chat.id}
                  menuOpen={menuForId === chat.id}
                  onDelete={onDeleteChat}
                  onMenuOpenChange={(next) =>
                    setMenuForId(next ? chat.id : null)
                  }
                  onRename={startRename}
                  onTogglePin={onTogglePinChat}
                  onSelect={onSelect}
                  renaming={renamingId === chat.id}
                  renameDraft={renameDraft}
                  onRenameDraftChange={setRenameDraft}
                  onCommitRename={commitRename}
                  onCancelRename={cancelRename}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* ── Section 3 · System menu ───────────────────────────── */}
      <div className="shrink-0 border-t p-2">
        <span className="px-2 pt-1 pb-1 block font-medium text-muted-foreground text-xs uppercase tracking-wide">
          System
        </span>
        <button
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            skillsActive
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
          onClick={onOpenSkills}
          type="button"
        >
          <Sparkle className="size-4" />
          Skills
        </button>
        <button
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            pluginsActive
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
          onClick={onOpenPlugins}
          type="button"
        >
          <PuzzlePiece className="size-4" />
          Plugins
        </button>
        <button
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            mcpActive
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
          onClick={onOpenMcp}
          type="button"
        >
          <PlugsConnected className="size-4" />
          MCP Servers
        </button>
        <button
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            statisticsActive
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
          onClick={onOpenStatistics}
          type="button"
        >
          <ChartBar className="size-4" />
          Statistics
        </button>
        <button
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            settingsActive
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          )}
          onClick={onOpenSettings}
          type="button"
        >
          <GearSix className="size-4" />
          Settings
        </button>
      </div>
    </aside>
  );
}

/**
 * One history row: select on click, ⋯ (or right-click) opens the context
 * menu with Rename / Pin / Delete, and rename swaps the label for an
 * inline input.
 */
function ChatRow({
  activeChatId,
  chat,
  menuOpen,
  onCancelRename,
  onCommitRename,
  onDelete,
  onMenuOpenChange,
  onRename,
  onRenameDraftChange,
  onSelect,
  onTogglePin,
  renameDraft,
  renaming,
}: {
  activeChatId: string | null;
  chat: StoredChat;
  menuOpen: boolean;
  onCancelRename: () => void;
  onCommitRename: () => void;
  onDelete: (id: string) => void;
  onMenuOpenChange: (open: boolean) => void;
  onRename: (chat: StoredChat) => void;
  onRenameDraftChange: (value: string) => void;
  onSelect: (id: string) => void;
  onTogglePin: (id: string) => void;
  renameDraft: string;
  renaming: boolean;
}) {
  const isActive = chat.id === activeChatId;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  return (
    <div
      className={cn(
        // `min-w-0` lets the inner title button shrink past its content so
        // long auto-generated titles truncate instead of expanding the row
        // and pushing the context-menu trigger out of view.
        "group flex min-w-0 items-center rounded-md",
        isActive
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      )}
      key={chat.id}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenuOpenChange(true);
      }}
    >
      {renaming ? (
        <input
          autoFocus
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-foreground text-sm outline-none focus:ring-1 focus:ring-ring"
          onBlur={onCommitRename}
          onChange={(event) => onRenameDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onCommitRename();
            if (event.key === "Escape") onCancelRename();
          }}
          ref={inputRef}
          value={renameDraft}
        />
      ) : (
        <button
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
          onClick={() => onSelect(chat.id)}
          type="button"
        >
          {chat.pinned ? (
            <PushPin className="size-4 shrink-0 text-primary" weight="fill" />
          ) : (
            <ChatCircleText className="size-4 shrink-0" />
          )}
          <span className="truncate">{chat.title}</span>
        </button>
      )}

      <DropdownMenu onOpenChange={onMenuOpenChange} open={menuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Options for ${chat.title}`}
            className={cn(
              // `shrink-0` guarantees the trigger is never compressed, and
              // keeps it inside the row's flex flow so it stays visible at
              // the right edge regardless of title length.
              "mr-1 shrink-0 transition-opacity",
              menuOpen || isActive
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            )}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <DotsThreeVertical className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        {/* align="end": anchor the menu to the trigger's right edge so it
            opens leftward inside the sidebar, not rightward into the chat. */}
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem onClick={() => onRename(chat)}>
            <PencilSimple className="size-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onTogglePin(chat.id)}>
            {chat.pinned ? (
              <PushPinSlash className="size-4" />
            ) : (
              <PushPin className="size-4" />
            )}
            {chat.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => onDelete(chat.id)}
          >
            <Trash className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
