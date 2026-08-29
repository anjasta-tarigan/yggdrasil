import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  MessageActions,
  MessageAction,
} from "@/components/ai-elements/message";

describe("Message Actions Component", () => {
  it("renders copy and regenerate actions with click handlers", () => {
    const handleCopy = vi.fn();
    const handleRegenerate = vi.fn();

    render(
      <MessageActions>
        <MessageAction label="Copy message" onClick={handleCopy}>
          Copy
        </MessageAction>
        <MessageAction label="Regenerate response" onClick={handleRegenerate}>
          Regenerate
        </MessageAction>
      </MessageActions>
    );

    const copyBtn = screen.getByRole("button", { name: /Copy message/i });
    const regenBtn = screen.getByRole("button", { name: /Regenerate response/i });

    fireEvent.click(copyBtn);
    expect(handleCopy).toHaveBeenCalledTimes(1);

    fireEvent.click(regenBtn);
    expect(handleRegenerate).toHaveBeenCalledTimes(1);
  });
});
