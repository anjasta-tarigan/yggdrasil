import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MessageParts } from "../MessageParts";
import type { ChatUIMessage } from "@/app/api/chat/route";

describe("MessageParts with Image Search Integration", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders image gallery BEFORE text in DOM order when image_search is called", () => {
    const message: ChatUIMessage = {
      id: "msg_1",
      role: "assistant",
      parts: [
        {
          type: "tool-invocation",
          toolCallId: "call_img_1",
          toolName: "image_search",
          input: { query: "RTX 5090" },
          state: "output-available",
          output: {
            query: "RTX 5090",
            results: [
              {
                title: "NVIDIA RTX 5090",
                image_url: "https://example.com/5090.jpg",
                source_url: "https://nvidia.com/5090",
                source_name: "nvidia.com",
                rank: 1,
              },
            ],
          },
        },
        {
          type: "text",
          text: "The RTX 5090 is NVIDIA's flagship graphics card based on the Blackwell architecture.",
        },
      ],
    } as unknown as ChatUIMessage;

    render(
      <MessageParts
        message={message}
        isLastMessage={true}
        isStreaming={false}
        onOpenArtifact={vi.fn()}
      />
    );

    // Text should be rendered
    const textEl = screen.getByText(
      /flagship graphics card based on the Blackwell architecture/i
    );
    expect(textEl).toBeInTheDocument();

    // Image gallery should be rendered
    const img = screen.getByRole("img", { name: /NVIDIA RTX 5090/i });
    expect(img).toBeInTheDocument();

    // Attribution link should be present
    expect(screen.getByRole("link", { name: /nvidia\.com/i })).toBeInTheDocument();

    // CRITICAL: Image MUST appear BEFORE text in DOM order
    // Node.DOCUMENT_POSITION_FOLLOWING (4) means textEl follows img in document order
    expect(
      img.compareDocumentPosition(textEl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("consolidates multiple image_search calls to prevent excessive image dumps", () => {
    const message: ChatUIMessage = {
      id: "msg_multi",
      role: "assistant",
      parts: [
        {
          type: "tool-invocation",
          toolCallId: "call_eniac",
          toolName: "image_search",
          input: { query: "ENIAC photo" },
          state: "output-available",
          output: {
            query: "ENIAC photo",
            results: [
              {
                title: "ENIAC Computer",
                image_url: "https://example.com/eniac.jpg",
                source_name: "loc.gov",
                rank: 1,
              },
              {
                title: "ENIAC Detail",
                image_url: "https://example.com/eniac2.jpg",
                source_name: "loc.gov",
                rank: 2,
              },
            ],
          },
        },
        {
          type: "tool-invocation",
          toolCallId: "call_univac",
          toolName: "image_search",
          input: { query: "UNIVAC photo" },
          state: "output-available",
          output: {
            query: "UNIVAC photo",
            results: [
              {
                title: "UNIVAC Computer",
                image_url: "https://example.com/univac.jpg",
                source_name: "si.edu",
                rank: 1,
              },
            ],
          },
        },
        {
          type: "text",
          text: "Here is a comparison of ENIAC and UNIVAC...",
        },
      ],
    } as unknown as ChatUIMessage;

    render(
      <MessageParts
        message={message}
        isLastMessage={true}
        isStreaming={false}
        onOpenArtifact={vi.fn()}
      />
    );

    // Total displayed images across multiple calls capped at 2 for normal comparison
    const images = screen.getAllByRole("img");
    expect(images.length).toBeLessThanOrEqual(2);
    expect(screen.getByRole("img", { name: /ENIAC Computer/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /UNIVAC Computer/i })).toBeInTheDocument();

    const textEl = screen.getByText(/Here is a comparison of ENIAC and UNIVAC/i);
    // Both images appear before the text
    expect(
      images[0].compareDocumentPosition(textEl) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("excludes image_search from generic ToolCallsTrail", () => {
    const message: ChatUIMessage = {
      id: "msg_2",
      role: "assistant",
      parts: [
        {
          type: "tool-invocation",
          toolCallId: "call_img_2",
          toolName: "image_search",
          input: { query: "Eiffel Tower" },
          state: "output-available",
          output: {
            query: "Eiffel Tower",
            results: [
              {
                title: "Eiffel Tower",
                image_url: "https://example.com/eiffel.jpg",
                rank: 1,
              },
            ],
          },
        },
      ],
    } as unknown as ChatUIMessage;

    render(
      <MessageParts
        message={message}
        isLastMessage={true}
        isStreaming={false}
        onOpenArtifact={vi.fn()}
      />
    );

    // Should NOT render Built-in Tools accordion for image_search
    expect(screen.queryByText("Built-in Tools")).not.toBeInTheDocument();
  });
});
