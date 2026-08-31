"use client";

import { cn } from "@/lib/utils";
import type { StoredChat } from "@/lib/chat-storage";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEffect, useMemo, useRef, useState } from "react";
import { BRAND } from "@/lib/brand";
import { formatRelativeTime } from "@/lib/relative-time";
import {
  ChartBar,
  ChatCircle,
  ChatCircleText,
  CheckSquare,
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
  Square,
  Trash,
  X,
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
  /** Bulk-delete the given chat ids (optimistic; rolls back on failure). */
  onDeleteChatsBulk: (ids: string[]) => void;
  onRenameChat: (id: string, title: string) => void;
  onTogglePinChat: (id: string) => void;
  onOpenSettings: () => void;
  onOpenMcp: () => void;
  onOpenSkills: () => void;
  onOpenPlugins: () => void;
  onOpenStatistics: () => void;
};

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
  onDeleteChatsBulk,
  onRenameChat,
  onTogglePinChat,
  onOpenSettings,
  onOpenMcp,
  onOpenSkills,
  onOpenPlugins,
  onOpenStatistics,
}: SidebarProps) {
  const [menuForId, setMenuForId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // ---- Bulk selection state ----
  const [selectMode, setSelectMode] = useState(false);
  // Only the ids present in the current list are selectable; selection
  // is pruned against `chats` on every render so ids of chats deleted
  // elsewhere (or already bulk-deleted optimistically) can never linger
  // and be re-submitted to the delete API.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
    setConfirmDelete(false);
  };

  // Prune selection against live chats: protects against the window
  // between an optimistic bulk-delete (rows already gone from `chats`)
  // and the user clicking Delete on a stale selection, and against
  // chats removed by a background sync.
  const selectableIds = useMemo(
    () => new Set(chats.map((c) => c.id)),
    [chats]
  );
  const liveSelection = useMemo(
    () => [...selectedIds].filter((id) => selectableIds.has(id)),
    [selectedIds, selectableIds]
  );

  // Esc leaves select mode first, then clears selection — standard
  // two-stage escape for multiselect surfaces.
  useEffect(() => {
    if (!selectMode) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirmDelete) return; // dialog manages its own escape
      if (selectedIds.size > 0) setSelectedIds(new Set());
      else exitSelectMode();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, selectedIds.size, confirmDelete]);

  // Relative timestamps ("2 min ago") must not go stale while the app
  // sits open. A 30s tick re-renders the rows; Date.now() runs in the
  // tick callback (an event handler), never during render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // ---- Section 2 data: pinned group + recents ----
  const pinnedChats = chats.filter((c) => c.pinned);
  const recentChats = chats.filter((c) => !c.pinned);

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
            <span className="truncate text-sm font-semibold">{BRAND.name}</span>
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
          <div className="flex items-center gap-1">
            {chats.length > 0 && (
              <Button
                aria-label={
                  selectMode ? "Exit selection mode" : "Select conversations"
                }
                aria-pressed={selectMode}
                className={cn(
                  "h-6 gap-1 rounded-md px-1.5 text-xs transition-colors",
                  selectMode
                    ? "bg-muted font-semibold text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
                onClick={() =>
                  selectMode ? exitSelectMode() : setSelectMode(true)
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                {selectMode ? (
                  <X className="size-3.5" />
                ) : (
                  <CheckSquare className="size-3.5" />
                )}
                {selectMode ? "Done" : "Select"}
              </Button>
            )}
          </div>
        </div>

        {selectMode && (
          <div
            aria-label="Bulk selection actions"
            className="mx-2 mb-1.5 flex shrink-0 items-center gap-1 rounded-md border bg-background px-1.5 py-1"
          >
            <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
              {liveSelection.length} selected
            </span>
            <Button
              className="h-6 px-2 text-xs"
              onClick={() =>
                setSelectedIds(
                  new Set([...pinnedChats, ...recentChats].map((c) => c.id))
                )
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              Select all
            </Button>
            <Button
              className="h-6 gap-1 px-2 text-xs text-destructive hover:text-destructive"
              disabled={liveSelection.length === 0}
              onClick={() => setConfirmDelete(true)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Trash className="size-3.5" />
              Delete
            </Button>
          </div>
        )}

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
                <span className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground uppercase tracking-wide">
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
                    selectMode={selectMode}
                    selected={selectedIds.has(chat.id)}
                    onToggleSelect={toggleSelected}
                    now={now}
                  />
                ))}
                <div className="my-1 border-b" />
              </>
            )}

            {recentChats.length === 0 && pinnedChats.length === 0 ? (
              <p className="px-2 py-4 text-center text-muted-foreground text-xs">
                No conversations yet
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
                  selectMode={selectMode}
                  selected={selectedIds.has(chat.id)}
                  onToggleSelect={toggleSelected}
                  now={now}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Bulk-delete confirmation. liveSelection (pruned against live
          chats) is the source of truth for the count — never raw
          selectedIds, which may still hold optimistically-deleted ids. */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(false);
        }}
        open={confirmDelete}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Delete {liveSelection.length}{" "}
              {liveSelection.length === 1 ? "conversation" : "conversations"}?
            </DialogTitle>
            <DialogDescription>
              {(() => {
                const pinnedCount = liveSelection.filter((id) =>
                  chats.find((c) => c.id === id)?.pinned
                ).length;
                return pinnedCount > 0
                  ? `Includes ${pinnedCount} pinned ${pinnedCount === 1 ? "chat" : "charts"}. This permanently deletes the selected conversations and their messages.`
                  : "This permanently deletes the selected conversations and their messages.";
              })()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setConfirmDelete(false)}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                onDeleteChatsBulk(liveSelection);
                // Keep select mode but clear selection: the rows are gone
                // (optimistically), so lingering ids would be stale.
                setSelectedIds(new Set());
                setConfirmDelete(false);
              }}
              type="button"
              variant="destructive"
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
  selectMode,
  selected,
  onToggleSelect,
  now,
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
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  /** Tick timestamp for relative labels; rows re-render when it advances. */
  now: number;
}) {
  const isActive = chat.id === activeChatId;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const relative = formatRelativeTime(chat.updatedAt, now);

  return (
    <div
      className={cn(
        // `min-w-0` lets the inner title button shrink past its content so
        // long auto-generated titles truncate instead of expanding the row
        // and pushing the context-menu trigger out of view.
        "group flex min-w-0 items-center rounded-md",
        // Selection state outranks active state: the visual contract in
        // select mode is "checked or not", not "open or not".
        selected
          ? "bg-primary/10 text-foreground ring-1 ring-primary/40"
          : isActive
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      )}
      key={chat.id}
      onContextMenu={(event) => {
        if (selectMode) return; // no context menu while multi-selecting
        event.preventDefault();
        onMenuOpenChange(true);
      }}
    >
      {selectMode ? (
        <button
          aria-label={`${selected ? "Deselect" : "Select"} ${chat.title}`}
          aria-pressed={selected}
          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
          // In select mode the whole row toggles selection — never opens
          // the chat (a click meant to check would otherwise navigate).
          onClick={() => onToggleSelect(chat.id)}
          type="button"
        >
          {selected ? (
            <CheckSquare
              className="size-4 shrink-0 text-primary"
              weight="fill"
            />
          ) : (
            <Square className="size-4 shrink-0" />
          )}
          {chat.pinned ? (
            <PushPin className="size-4 shrink-0 text-primary" weight="fill" />
          ) : null}
          <span className="truncate">{chat.title}</span>
          <span className="ml-auto shrink-0 pl-1 text-xs text-muted-foreground">
            {relative}
          </span>
        </button>
      ) : renaming ? (
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
          <span className="ml-auto shrink-0 pl-1 text-xs text-muted-foreground">
            {relative}
          </span>
        </button>
      )}

      {!selectMode && (
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
      )}
    </div>
  );
}
