import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { Sidebar } from "@/components/sidebar";
import type { StoredChat } from "@/lib/chat-storage";

// vitest runs without globals:true, so RTL's auto-cleanup never registers.
afterEach(() => {
  cleanup();
});

const chat = (id: string, title: string, pinned?: boolean): StoredChat => ({
  id,
  title,
  updatedAt: Date.now(),
  messages: [],
  pinned,
});

describe("Sidebar bulk selection", () => {
  const baseProps = {
    activeChatId: "c1",
    chatActive: true,
    chats: [
      chat("c1", "Alpha"),
      chat("c2", "Beta"),
      chat("c3", "Pinned one", true),
    ],
    cronActive: false,
    mcpActive: false,
    onDeleteChat: vi.fn(),
    onNewChat: vi.fn(),
    onOpenChat: vi.fn(),
    onOpenCron: vi.fn(),
    onOpenMcp: vi.fn(),
    onOpenPlugins: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenSkills: vi.fn(),
    onOpenStatistics: vi.fn(),
    onRenameChat: vi.fn(),
    onSelect: vi.fn(),
    onToggle: vi.fn(),
    onTogglePinChat: vi.fn(),
    open: true,
    pluginsActive: false,
    settingsActive: false,
    skillsActive: false,
    statisticsActive: false,
  };

  it("shows the Select button only when history exists; rows navigate normally before select mode", () => {
    const onSelect = vi.fn();
    render(
      <Sidebar {...baseProps} onSelect={onSelect} onDeleteChatsBulk={vi.fn()} />
    );
    // Select button visible (history non-empty), but no action bar yet
    expect(
      screen.getByRole("button", { name: /select conversations/i })
    ).toBeInTheDocument();
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();

    // Rows navigate on click (not toggle selection)
    fireEvent.click(screen.getByText("Alpha"));
    expect(onSelect).toHaveBeenCalledWith("c1");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("entering select mode toggles rows without navigating", () => {
    const onSelect = vi.fn();
    render(
      <Sidebar {...baseProps} onSelect={onSelect} onDeleteChatsBulk={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: /select conversations/i }));

    fireEvent.click(screen.getByText("Alpha"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /select alpha/i })
    ).toBeInTheDocument();
  });

  it("shows an honest count and enables Delete only with a selection", () => {
    const onDeleteChatsBulk = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        onDeleteChatsBulk={onDeleteChatsBulk}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /select conversations/i }));

    // 0 selected → delete disabled
    expect(screen.getByText("0 selected")).toBeInTheDocument();
    const deleteBtn = screen.getByRole("button", { name: /delete/i });
    expect(deleteBtn).toBeDisabled();

    // Select two chats → count updates, delete enabled
    fireEvent.click(screen.getByText("Alpha"));
    fireEvent.click(screen.getByText("Beta"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete/i })).toBeEnabled();
  });

  it("confirm dialog counts pinned chats and bulk-deletes only live ids", () => {
    const onDeleteChatsBulk = vi.fn();
    render(
      <Sidebar {...baseProps} onDeleteChatsBulk={onDeleteChatsBulk} />
    );
    fireEvent.click(screen.getByRole("button", { name: /select conversations/i }));
    fireEvent.click(screen.getByText("Alpha"));
    fireEvent.click(screen.getByText("Pinned one"));
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    // Dialog shows total + pinned callout
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/2 conversations/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 pinned/i)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    expect(onDeleteChatsBulk).toHaveBeenCalledTimes(1);
    expect(onDeleteChatsBulk).toHaveBeenCalledWith(["c1", "c3"]);
  });

  it("Exit (Done) clears the selection and restores navigation", () => {
    const onSelect = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        onSelect={onSelect}
        onDeleteChatsBulk={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /select conversations/i }));
    fireEvent.click(screen.getByText("Alpha"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /exit selection mode/i }));
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Alpha"));
    expect(onSelect).toHaveBeenCalledWith("c1");
  });

  it("Escape first clears the selection, then exits select mode", () => {
    render(<Sidebar {...baseProps} onDeleteChatsBulk={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /select conversations/i }));
    fireEvent.click(screen.getByText("Alpha"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    // First Esc: clear selection but stay in select mode
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("0 selected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /exit selection mode/i })
    ).toBeInTheDocument();

    // Second Esc: exit select mode entirely
    fireEvent.keyDown(window, { key: "Escape" });
    expect(
      screen.queryByRole("button", { name: /exit selection mode/i })
    ).not.toBeInTheDocument();
  });
});
