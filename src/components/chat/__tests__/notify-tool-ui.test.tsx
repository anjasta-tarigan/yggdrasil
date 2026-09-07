import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";
import { StrictMode } from "react";
import { MessageParts } from "../MessageParts";
import { ToolInvocation } from "../ToolInvocation";
import type { ToolUIPart, UIMessage } from "ai";

// RTL auto-cleanup never registers in this setup (globals not enabled).
beforeEach(() => cleanup());
afterEach(() => cleanup());

const successPart = {
  type: "tool-notify_user",
  toolCallId: "call-1",
  toolName: "notify_user",
  state: "output-available",
  input: { title: "Build Succeeded", message: "All tests green", level: "success" },
  output: { delivered: true, title: "Build Succeeded", level: "success" },
} as unknown as ToolUIPart;

describe("notify_user Tool UI Rendering", () => {
  it("renders notification title and level clearly", () => {
    const part = {
      type: "tool-notify_user",
      toolCallId: "call-1",
      toolName: "notify_user",
      state: "output-available",
      input: { title: "Build Succeeded", message: "All tests green", level: "success" },
      output: { delivered: true, title: "Build Succeeded", level: "success" },
    } as unknown as ToolUIPart;

    render(<ToolInvocation part={part} />);
    expect(screen.getByText(/Build Succeeded/)).toBeInTheDocument();
  });

  it("shows the suppression reason when delivery was skipped", () => {
    const part = {
      type: "tool-notify_user",
      toolCallId: "call-suppressed",
      state: "output-available",
      input: { title: "Deploy done", message: "v2 shipped", level: "info" },
      output: { delivered: false, reason: "Rate limit exceeded (max 5/min)" },
    } as unknown as ToolUIPart;

    render(<ToolInvocation part={part} />);
    expect(screen.getByText(/Rate limit exceeded/)).toBeInTheDocument();
  });

  it("renders a level badge matching the notification severity", () => {
    const part = {
      type: "tool-notify_user",
      toolCallId: "call-warning",
      state: "output-available",
      input: { title: "Disk almost full", message: "Only 2GB left", level: "warning" },
      output: { delivered: true, title: "Disk almost full", message: "Only 2GB left", level: "warning" },
    } as unknown as ToolUIPart;

    render(<ToolInvocation part={part} />);
    expect(screen.getByText("warning")).toBeInTheDocument();
  });

  it("routes notify_user parts to the receipt card, not the built-in trail", () => {
    const message = {
      id: "msg-notify",
      role: "assistant",
      parts: [successPart],
    } as unknown as UIMessage;

    render(
      <MessageParts
        isLastMessage={false}
        isStreaming={false}
        message={message}
        onOpenArtifact={() => {}}
      />
    );

    expect(screen.getByText(/Build Succeeded/)).toBeInTheDocument();
    expect(screen.queryByText(/Built-in Tools/)).toBeNull();
  });
});

// jsdom ships neither Web Audio nor Notifications; stub both.
type MockOscillator = {
  frequency: { value: number };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

const oscillators: MockOscillator[] = [];
const contexts: MockAudioContext[] = [];

class MockAudioContext {
  currentTime = 0;
  destination = {};
  state = "running";
  close = vi.fn(() => Promise.resolve());
  constructor() {
    contexts.push(this);
  }
  createOscillator(): MockOscillator & {
    type: string;
    connect: () => { connect: () => void };
  } {
    const osc = {
      frequency: { value: 0 },
      type: "",
      connect: () => ({ connect: () => {} }),
      start: vi.fn(),
      stop: vi.fn(),
    };
    oscillators.push(osc);
    return osc;
  }
  createGain() {
    return {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: () => ({ connect: () => {} }),
    };
  }
  resume() {
    return Promise.resolve();
  }
}

const notifications: Array<{ title: string; options?: NotificationOptions }> = [];

class MockNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn();
  constructor(title: string, options?: NotificationOptions) {
    notifications.push({ title, options });
  }
}

describe("notify_user client side effects", () => {
  beforeEach(() => {
    oscillators.length = 0;
    contexts.length = 0;
    notifications.length = 0;
    MockNotification.permission = "granted";
    vi.useFakeTimers();
    (window as unknown as { AudioContext?: unknown }).AudioContext = MockAudioContext;
    (window as unknown as { Notification?: unknown }).Notification = MockNotification;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    delete (window as unknown as { Notification?: unknown }).Notification;
  });

  it("plays the success arpeggio (523Hz + 659Hz) on output-available", () => {
    render(<ToolInvocation part={successPart} />);
    const freqs = oscillators
      .map((o) => o.frequency.value)
      .sort((a, b) => a - b);
    expect(freqs).toEqual([523, 659]);
  });

  it("closes the AudioContext after the chime finishes playing", () => {
    render(<ToolInvocation part={successPart} />);
    // Chime is still scheduled; the context must not be released yet.
    expect(contexts[0].close).not.toHaveBeenCalled();

    // Success arpeggio: last tone ends at 0.12+0.35=0.47s, +0.3s buffer = 770ms.
    act(() => {
      vi.advanceTimersByTime(769);
    });
    expect(contexts[0].close).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
  });

  it("fires chime and system notification exactly once under StrictMode", () => {
    const part = {
      type: "tool-notify_user",
      toolCallId: "call-strict",
      state: "output-available",
      input: { title: "Ping", message: "single chime", level: "info" },
      output: { delivered: true, title: "Ping", message: "single chime", level: "info" },
    } as unknown as ToolUIPart;

    render(
      <StrictMode>
        <ToolInvocation part={part} />
      </StrictMode>
    );

    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].frequency.value).toBe(440);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      title: "Ping",
      options: { body: "single chime" },
    });
  });

  it("stays silent when sound is false", () => {
    const part = {
      type: "tool-notify_user",
      toolCallId: "call-muted",
      state: "output-available",
      input: { title: "Quiet", message: "no chime", level: "info", sound: false },
      output: { delivered: true, title: "Quiet", message: "no chime", level: "info", sound: false },
    } as unknown as ToolUIPart;

    render(<ToolInvocation part={part} />);
    expect(oscillators).toHaveLength(0);
  });

  it("never dispatches a system notification without granted permission", () => {
    MockNotification.permission = "denied";
    render(<ToolInvocation part={successPart} />);
    expect(notifications).toHaveLength(0);
  });

  it("renders the pending receipt without a suppression verdict before output arrives", () => {
    const part = {
      type: "tool-notify_user",
      toolCallId: "call-pending",
      state: "input-available",
      input: { title: "Deploying now", message: "will notify on done", level: "info" },
    } as unknown as ToolUIPart;

    render(<ToolInvocation part={part} />);
    expect(screen.getByText("Deploying now")).toBeInTheDocument();
    expect(screen.getByText("will notify on done")).toBeInTheDocument();
    expect(screen.queryByText(/Delivery suppressed/)).toBeNull();
  });

  it("falls back to the input message for the notification body", () => {
    const part = {
      type: "tool-notify_user",
      toolCallId: "call-input-fallback",
      state: "output-available",
      input: { title: "Ping", message: "input body", level: "info" },
      output: { delivered: true },
    } as unknown as ToolUIPart;

    render(<ToolInvocation part={part} />);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      title: "Ping",
      options: { body: "input body" },
    });
  });

  it("never requests notification permission automatically", () => {
    render(<ToolInvocation part={successPart} />);
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
  });
});
