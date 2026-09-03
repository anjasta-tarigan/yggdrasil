import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { QuestionModal } from "@/components/ai-elements/question-modal";
import type { ToolUIPart } from "ai";

// RTL auto-cleanup never registers in this setup (globals not enabled).
beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const singleQuestionInput = {
  questions: [
    {
      question: "Which database?",
      header: "Database",
      multiSelect: false,
      options: [
        { label: "PostgreSQL", description: "relational" },
        { label: "SQLite", description: "embedded" },
      ],
    },
  ],
};

const multiQuestionInput = {
  questions: [
    {
      question: "Which framework?",
      header: "Framework",
      multiSelect: false,
      options: [
        { label: "Next.js", description: "react metaframework" },
        { label: "Astro", description: "islands" },
      ],
    },
    {
      question: "Which styling?",
      header: "Styling",
      multiSelect: false,
      options: [
        { label: "Tailwind", description: "utility css" },
        { label: "Vanilla", description: "plain css" },
      ],
    },
  ],
};

const partWith = (
  input: unknown,
  toolCallId = "call-q-1",
  state: ToolUIPart["state"] = "input-available"
): ToolUIPart =>
  ({
    type: "tool-ask_user_question",
    toolCallId,
    state,
    input,
  }) as unknown as ToolUIPart;

describe("QuestionModal (popup QnA)", () => {
  it("renders the interactive question UI in a dialog when open", () => {
    render(
      <QuestionModal
        onAnswer={() => {}}
        onOpenChange={() => {}}
        open
        part={partWith(singleQuestionInput)}
      />
    );

    expect(screen.getByText("Which database?")).toBeInTheDocument();
    expect(screen.getByText("PostgreSQL")).toBeInTheDocument();
    // Options must be interactive while the popup is open.
    expect(
      screen.getByRole("button", { name: /PostgreSQL/i })
    ).toBeInTheDocument();
  });

  it("renders nothing interactive when closed", () => {
    render(
      <QuestionModal
        onAnswer={() => {}}
        onOpenChange={() => {}}
        open={false}
        part={partWith(singleQuestionInput)}
      />
    );

    expect(screen.queryByText("Which database?")).toBeNull();
  });

  it("answers a single question directly and closes itself", () => {
    const onAnswer = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <QuestionModal
        onAnswer={onAnswer}
        onOpenChange={onOpenChange}
        open
        part={partWith(singleQuestionInput)}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /PostgreSQL/i }));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({
      "Which database?": "PostgreSQL",
    });
    // The modal must close so the auto-continue can resume the chat.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("declines ALL questions when dismissed without answering (not just the first)", () => {
    const onAnswer = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <QuestionModal
        onAnswer={onAnswer}
        onOpenChange={onOpenChange}
        open
        part={partWith(multiQuestionInput)}
      />
    );

    // User dismisses the popup (Escape/overlay handled internally by
    // QuestionModal intercepting onOpenChange(false)).
    const modal = screen.getByText("Which framework?");
    fireEvent.keyDown(modal.ownerDocument.body, { key: "Escape" });

    // Every unanswered question gets a decline marker, not just q1.
    expect(onAnswer).toHaveBeenCalledWith({
      "Which framework?": "User declined to answer the question.",
      "Which styling?": "User declined to answer the question.",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("exposes an accessible name for the dialog", () => {
    render(
      <QuestionModal
        onAnswer={() => {}}
        onOpenChange={() => {}}
        open
        part={partWith(singleQuestionInput)}
      />
    );

    // Radix dialogs must carry a title for screen readers.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
  });

  it("declines exactly once when dismissed by an overlay click (Radix fires two outside events)", async () => {
    const onAnswer = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <QuestionModal
        onAnswer={onAnswer}
        onOpenChange={onOpenChange}
        open
        part={partWith(multiQuestionInput)}
      />
    );

    // A real overlay dismissal is pointerdown + click on the overlay.
    // Radix (deferPointerDownOutside) dispatches on the click, and one
    // interaction invokes BOTH onPointerDownOutside AND onInteractOutside
    // — the modal must decline exactly once for the whole sequence.
    const overlay = document.querySelector(
      '[data-slot="dialog-overlay"]'
    ) as HTMLElement;
    expect(overlay).not.toBeNull();

    await act(async () => {
      // Let Radix attach its deferred document listeners first.
      await new Promise((resolve) => setTimeout(resolve, 10));
      fireEvent.pointerDown(overlay);
      fireEvent.click(overlay);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({
      "Which framework?": "User declined to answer the question.",
      "Which styling?": "User declined to answer the question.",
    });
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("declines exactly once when dismissed with Escape", () => {
    const onAnswer = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <QuestionModal
        onAnswer={onAnswer}
        onOpenChange={onOpenChange}
        open
        part={partWith(singleQuestionInput)}
      />
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({
      "Which database?": "User declined to answer the question.",
    });
  });

  it("passes answers through the paged wizard (one question per page)", () => {
    const onAnswer = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <QuestionModal
        onAnswer={onAnswer}
        onOpenChange={onOpenChange}
        open
        part={partWith(multiQuestionInput)}
      />
    );

    // Page 1/2: pick an option — advances, no submit yet.
    fireEvent.click(screen.getByRole("button", { name: /Next\.js/i }));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();

    // Page 2/2 (last): answering submits everything at once.
    fireEvent.click(screen.getByRole("button", { name: /Tailwind/i }));

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith({
      "Which framework?": "Next.js",
      "Which styling?": "Tailwind",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
