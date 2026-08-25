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

export const chatActiveTracker = new ChatActiveTracker();
