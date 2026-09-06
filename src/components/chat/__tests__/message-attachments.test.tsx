import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MessageAttachments } from "@/components/chat/MessageAttachments";
import type { FileUIPart } from "ai";

beforeEach(() => {
  cleanup();
});
afterEach(() => {
  cleanup();
});

const mockFiles: FileUIPart[] = [
  {
    type: "file",
    filename: "test-doc.pdf",
    mediaType: "application/pdf",
    url: "https://example.com/test-doc.pdf",
  },
  {
    type: "file",
    filename: "landscape.png",
    mediaType: "image/png",
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  },
];

describe("MessageAttachments component", () => {
  it("returns null when attachments array is empty", () => {
    const { container } = render(
      <MessageAttachments attachments={[]} messageId="msg-empty" />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders attachments in grid layout outside message bubble", () => {
    render(
      <MessageAttachments
        attachments={mockFiles}
        className="ml-auto"
        messageId="msg-1"
      />
    );

    const img = screen.getByRole("img");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("alt", "landscape.png");
  });

  it("renders remove buttons when onRemove callback is provided", () => {
    const onRemove = vi.fn();
    render(
      <MessageAttachments
        attachments={mockFiles}
        messageId="msg-1"
        onRemove={onRemove}
      />
    );

    const removeButtons = screen.getAllByRole("button", { name: /Remove/i });
    expect(removeButtons).toHaveLength(2);

    fireEvent.click(removeButtons[0]);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("file-msg-1-0");
  });

  it("preserves explicit id if present on attachment", () => {
    const onRemove = vi.fn();
    const fileWithId = [
      {
        id: "custom-file-id",
        type: "file" as const,
        filename: "custom.png",
        mediaType: "image/png",
        url: "data:image/png;base64,abc",
      },
    ];

    render(
      <MessageAttachments
        attachments={fileWithId}
        messageId="msg-1"
        onRemove={onRemove}
      />
    );

    const removeButton = screen.getByRole("button", { name: /Remove/i });
    fireEvent.click(removeButton);
    expect(onRemove).toHaveBeenCalledWith("custom-file-id");
  });
});
