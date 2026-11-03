class ChatActiveTracker {
  private activeCount = 0;

  startChat(): void {
    this.activeCount++;
  }

  endChat(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  isChatActive(): boolean {
    return this.activeCount > 0;
  }

  // Reset for test cleanup or server restart
  reset(): void {
    this.activeCount = 0;
  }
}

/**
 * The tracker is pinned to `globalThis` so it survives dev-server HMR module
 * reloads. A module-scoped singleton would be re-created on every reload, and
 * an in-flight chat request from the *previous* module generation would still
 * hold (and decrement) the old instance's counter while `isChatActive()` reads
 * the fresh instance — leaking the count above zero forever and permanently
 * deferring background queue jobs. The queue runner already uses the same
 * globalThis-pinning pattern for exactly this reason.
 */
const CHAT_TRACKER_KEY = "__yggdrasilChatActiveTracker";

function chatActiveTrackerInstance(): ChatActiveTracker {
  const g = globalThis as unknown as Record<string, ChatActiveTracker | undefined>;
  if (!g[CHAT_TRACKER_KEY]) {
    g[CHAT_TRACKER_KEY] = new ChatActiveTracker();
  }
  return g[CHAT_TRACKER_KEY];
}

export const chatActiveTracker = chatActiveTrackerInstance();
