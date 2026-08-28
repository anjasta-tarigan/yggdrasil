import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "@/components/sidebar";
import type { StoredChat } from "@/lib/chat-storage";

describe("Sidebar Navigation with Project Menu", () => {
  const dummyChats: StoredChat[] = [];

  it("renders Chat, Project, and Cron Job in main menu section", () => {
    const handleOpenProjects = vi.fn();
    const handleOpenChat = vi.fn();
    const handleOpenCron = vi.fn();

    render(
      <Sidebar
        activeChatId={null}
        chatActive={false}
        chats={dummyChats}
        cronActive={false}
        mcpActive={false}
        onDeleteChat={vi.fn()}
        onNewChat={vi.fn()}
        onOpenChat={handleOpenChat}
        onOpenCron={handleOpenCron}
        onOpenMcp={vi.fn()}
        onOpenPlugins={vi.fn()}
        onOpenProjects={handleOpenProjects}
        onOpenSettings={vi.fn()}
        onOpenSkills={vi.fn()}
        onOpenStatistics={vi.fn()}
        onRenameChat={vi.fn()}
        onSelect={vi.fn()}
        onToggle={vi.fn()}
        onTogglePinChat={vi.fn()}
        open={true}
        pluginsActive={false}
        projectsActive={true}
        settingsActive={false}
        skillsActive={false}
        statisticsActive={false}
      />
    );

    const projectBtn = screen.getByRole("button", { name: /^project$/i });
    expect(projectBtn).toBeInTheDocument();

    fireEvent.click(projectBtn);
    expect(handleOpenProjects).toHaveBeenCalledTimes(1);
  });
});
