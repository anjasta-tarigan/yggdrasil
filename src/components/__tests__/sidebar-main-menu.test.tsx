import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Sidebar } from "@/components/sidebar";
import type { StoredChat } from "@/lib/chat-storage";

// vitest runs without globals:true, so RTL's auto-cleanup never registers.
afterEach(() => {
  cleanup();
});

describe("Sidebar Navigation with Main Menu Chat and Cron Job", () => {
  const dummyChats: StoredChat[] = [
    {
      id: "chat-1",
      title: "First Conversation",
      updatedAt: Date.now(),
      messages: [],
    },
  ];

  it("renders Chat and Cron Job buttons in Main menu section", () => {
    const handleOpenChat = vi.fn();
    const handleOpenCron = vi.fn();
    const handleNewChat = vi.fn();

    render(
      <Sidebar
        activeChatId="chat-1"
        chatActive={true}
        chats={dummyChats}
        cronActive={false}
        mcpActive={false}
        onDeleteChat={vi.fn()}
        onDeleteChatsBulk={vi.fn()}
        onNewChat={handleNewChat}
        onOpenChat={handleOpenChat}
        onOpenCron={handleOpenCron}
        onOpenMcp={vi.fn()}
        onOpenPlugins={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenStatistics={vi.fn()}
        onRenameChat={vi.fn()}
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        onTogglePinChat={vi.fn()}
        open={true}
        pluginsActive={false}
        settingsActive={false}
        skillsActive={false}
        statisticsActive={false}
      />
    );

    const chatButton = screen.getByRole("button", { name: /^chat$/i });
    const cronButton = screen.getByRole("button", { name: /^cron job$/i });

    expect(chatButton).toBeInTheDocument();
    expect(cronButton).toBeInTheDocument();

    fireEvent.click(chatButton);
    expect(handleOpenChat).toHaveBeenCalledTimes(1);

    fireEvent.click(cronButton);
    expect(handleOpenCron).toHaveBeenCalledTimes(1);
  });

  it("renders the Subagents button and fires onOpenSubagents", () => {
    const handleOpenSubagents = vi.fn();

    render(
      <Sidebar
        activeChatId="chat-1"
        chatActive={false}
        chats={dummyChats}
        cronActive={false}
        mcpActive={false}
        onDeleteChat={vi.fn()}
        onDeleteChatsBulk={vi.fn()}
        onNewChat={vi.fn()}
        onOpenChat={vi.fn()}
        onOpenCron={vi.fn()}
        onOpenSubagents={handleOpenSubagents}
        onOpenMcp={vi.fn()}
        onOpenPlugins={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenStatistics={vi.fn()}
        onRenameChat={vi.fn()}
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        onTogglePinChat={vi.fn()}
        open={true}
        pluginsActive={false}
        settingsActive={false}
        skillsActive={false}
        statisticsActive={false}
        subagentsActive={true}
      />
    );

    const subagentsButton = screen.getByRole("button", {
      name: /^subagents$/i,
    });
    expect(subagentsButton).toBeInTheDocument();

    fireEvent.click(subagentsButton);
    expect(handleOpenSubagents).toHaveBeenCalledTimes(1);
  });

  it("renders the Projects button and fires onOpenProjects", () => {
    const handleOpenProjects = vi.fn();

    render(
      <Sidebar
        activeChatId="chat-1"
        chatActive={false}
        projectsActive={true}
        chats={dummyChats}
        cronActive={false}
        mcpActive={false}
        onDeleteChat={vi.fn()}
        onDeleteChatsBulk={vi.fn()}
        onNewChat={vi.fn()}
        onOpenChat={vi.fn()}
        onOpenProjects={handleOpenProjects}
        onOpenCron={vi.fn()}
        onOpenSubagents={vi.fn()}
        onOpenMcp={vi.fn()}
        onOpenPlugins={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenStatistics={vi.fn()}
        onRenameChat={vi.fn()}
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        onTogglePinChat={vi.fn()}
        open={true}
        pluginsActive={false}
        settingsActive={false}
        skillsActive={false}
        statisticsActive={false}
        subagentsActive={false}
      />
    );

    const projectsButton = screen.getByRole("button", {
      name: /^projects$/i,
    });
    expect(projectsButton).toBeInTheDocument();

    fireEvent.click(projectsButton);
    expect(handleOpenProjects).toHaveBeenCalledTimes(1);
  });

  /**
   * The collapsed rail and the expanded menu each enumerate every destination,
   * so adding one means editing both. Nothing enforces that today (Rule of
   * Three says two instances don't yet justify a shared source), so this test
   * pins the parity instead: if a destination lands in one menu and not the
   * other, the two lists diverge and this fails.
   *
   * Compared as sets, because the two menus legitimately differ in order
   * ("New chat" leads the expanded menu's outline button group but sits with
   * the destinations in the rail).
   */
  it("offers the same destinations in the collapsed rail and the expanded menu", () => {
    const props = {
      activeChatId: "chat-1",
      chats: dummyChats,
      onDeleteChat: vi.fn(),
      onDeleteChatsBulk: vi.fn(),
      onNewChat: vi.fn(),
      onOpenChat: vi.fn(),
      onOpenCron: vi.fn(),
      onOpenMcp: vi.fn(),
      onOpenPlugins: vi.fn(),
      onOpenProjects: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenSkills: vi.fn(),
      onOpenStatistics: vi.fn(),
      onOpenSubagents: vi.fn(),
      onRenameChat: vi.fn(),
      onSelect: vi.fn(),
      onToggle: vi.fn(),
      onTogglePinChat: vi.fn(),
      settingsActive: false,
      mcpActive: false,
      skillsActive: false,
      pluginsActive: false,
      statisticsActive: false,
    };

    const { unmount } = render(<Sidebar {...props} open={true} />);
    const expanded = new Set(
      screen
        .getAllByRole("button")
        .map((b) => b.textContent?.trim() ?? "")
        .filter((t) =>
          [
            "New chat",
            "Chat",
            "Projects",
            "Cron Job",
            "Subagents",
            "Skills",
            "Plugins",
            "MCP Servers",
            "Statistics",
            "Settings",
          ].includes(t)
        )
    );
    unmount();

    render(<Sidebar {...props} open={false} />);
    const railLabels = new Set(
      Array.from(
        screen
          .getByRole("navigation", { name: "Primary" })
          .querySelectorAll("[aria-label]")
      )
        .map((el) => el.getAttribute("aria-label") ?? "")
        // The rail's top control expands it; it is chrome, not a destination.
        .filter((label) => label !== "Expand sidebar")
    );

    expect([...railLabels].sort()).toEqual([...expanded].sort());
  });
});
