import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "@/components/sidebar";
import type { StoredChat } from "@/lib/chat-storage";

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
});
