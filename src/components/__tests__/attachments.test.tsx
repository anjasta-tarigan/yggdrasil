import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import {
  Attachments,
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
} from "@/components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputActionAddAttachments,
  PromptInputActionAddScreenshot,
} from "@/components/ai-elements/prompt-input";
import type { FileUIPart } from "ai";
import { beforeEach } from "vitest";

describe("Attachments component", () => {
  beforeEach(() => {
    cleanup();
  });

  const mockFile: FileUIPart & { id: string } = {
    id: "file-1",
    type: "file",
    filename: "test-image.png",
    mediaType: "image/png",
    url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  };

  it("renders inline variant with remove button", () => {
    const onRemove = vi.fn();
    render(
      <Attachments variant="inline">
        <Attachment data={mockFile} onRemove={onRemove}>
          <AttachmentPreview />
          <AttachmentRemove />
        </Attachment>
      </Attachments>
    );

    expect(screen.getByRole("img")).toBeInTheDocument();
    const removeButton = screen.getByRole("button", { name: "Remove" });
    expect(removeButton).toBeInTheDocument();

    fireEvent.click(removeButton);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("renders grid variant with image preview", () => {
    render(
      <Attachments variant="grid">
        <Attachment data={mockFile}>
          <AttachmentPreview />
        </Attachment>
      </Attachments>
    );

    const img = screen.getByRole("img");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", mockFile.url);
    expect(img).toHaveAttribute("alt", "test-image.png");
    // Grid variant does not show remove button by default (unless passed)
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("renders fallback icon for unknown media type", () => {
    const unknownFile: FileUIPart & { id: string } = {
      id: "file-2",
      type: "file",
      filename: "unknown.bin",
      mediaType: "application/octet-stream",
      url: "blob:mock",
    };
    render(
      <Attachments variant="inline">
        <Attachment data={unknownFile}>
          <AttachmentPreview />
        </Attachment>
      </Attachments>
    );

    const svg = document.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("calls onRemove when remove button clicked in inline variant", () => {
    const onRemove = vi.fn();
    render(
      <Attachments variant="inline">
        <Attachment data={mockFile} onRemove={onRemove}>
          <AttachmentPreview />
          <AttachmentRemove />
        </Attachment>
      </Attachments>
    );

    const removeButton = screen.getByRole("button", { name: "Remove" });
    fireEvent.click(removeButton);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("does not render remove button when onRemove is not provided", () => {
    render(
      <Attachments variant="inline">
        <Attachment data={mockFile}>
          <AttachmentPreview />
          <AttachmentRemove />
        </Attachment>
      </Attachments>
    );

    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });

  it("renders PromptInputActionAddScreenshot and triggers screenshot capture on selection", async () => {
    const mockTrack = { stop: vi.fn() };
    const mockStream = {
      getTracks: vi.fn().mockReturnValue([mockTrack]),
    };

    const mockGetDisplayMedia = vi.fn().mockResolvedValue(mockStream);

    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getDisplayMedia: mockGetDisplayMedia,
      },
      writable: true,
      configurable: true,
    });

    const onSubmit = vi.fn();
    render(
      <PromptInput onSubmit={onSubmit}>
        <PromptInputActionMenu open={true}>
          <PromptInputActionMenuTrigger aria-label="Add action" />
          <PromptInputActionMenuContent>
            <PromptInputActionAddAttachments />
            <PromptInputActionAddScreenshot />
          </PromptInputActionMenuContent>
        </PromptInputActionMenu>
      </PromptInput>
    );

    const screenshotItem = await screen.findByRole("menuitem", {
      name: /Take screenshot/i,
    });
    expect(screenshotItem).toBeInTheDocument();

    const attachmentItem = screen.getByRole("menuitem", {
      name: /Add photos or files/i,
    });
    expect(attachmentItem).toBeInTheDocument();

    // Select screenshot action
    await act(async () => {
      fireEvent.click(screenshotItem);
    });

    expect(mockGetDisplayMedia).toHaveBeenCalledWith({
      audio: false,
      video: true,
    });
  });
});

