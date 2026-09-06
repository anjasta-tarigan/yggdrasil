import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  MessageActions,
  MessageAction,
} from "@/components/ai-elements/message";
import { Sparkle } from "@phosphor-icons/react";

describe("Message Actions Component", () => {
  it("renders copy, regenerate, and slop indicator actions with click handlers", () => {
    const handleCopy = vi.fn();
    const handleRegenerate = vi.fn();

    render(
      <MessageActions>
        <MessageAction
          label="Slop score: 0"
          tooltip="Anti-Slop: CLEAN (100% signal) — High signal"
          className="text-emerald-500"
        >
          <Sparkle className="size-3.5" weight="fill" />
        </MessageAction>
        <MessageAction label="Copy message" onClick={handleCopy}>
          Copy
        </MessageAction>
        <MessageAction label="Regenerate response" onClick={handleRegenerate}>
          Regenerate
        </MessageAction>
      </MessageActions>
    );

    const slopBtn = screen.getByRole("button", { name: /Slop score: 0/i });
    expect(slopBtn).toBeDefined();

    const copyBtn = screen.getByRole("button", { name: /Copy message/i });
    const regenBtn = screen.getByRole("button", { name: /Regenerate response/i });

    fireEvent.click(copyBtn);
    expect(handleCopy).toHaveBeenCalledTimes(1);

    fireEvent.click(regenBtn);
    expect(handleRegenerate).toHaveBeenCalledTimes(1);
  });
});
