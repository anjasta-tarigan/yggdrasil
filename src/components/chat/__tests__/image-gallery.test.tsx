import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ImageGallery } from "../ImageGallery";
import type { ToolUIPart } from "ai";

describe("ImageGallery Component", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders loading skeleton during streaming/input states", () => {
    const part: ToolUIPart = {
      type: "tool-invocation",
      toolCallId: "call_img_1",
      toolName: "image_search",
      input: { query: "RTX 5090 official photo" },
      state: "input-available",
    } as unknown as ToolUIPart;

    render(<ImageGallery part={part} />);
    expect(screen.getByText(/Searching images for/i)).toBeInTheDocument();
    expect(screen.getByText(/"RTX 5090 official photo"/i)).toBeInTheDocument();
  });

  it("renders graceful note on tool output-error", () => {
    const part: ToolUIPart = {
      type: "tool-invocation",
      toolCallId: "call_img_err",
      toolName: "image_search",
      input: { query: "Mars rover" },
      state: "output-error",
      errorText: "Provider timeout",
    } as unknown as ToolUIPart;

    render(<ImageGallery part={part} />);
    expect(screen.getByText(/Image search unavailable/i)).toBeInTheDocument();
  });

  it("renders empty state message when no results are found", () => {
    const part: ToolUIPart = {
      type: "tool-invocation",
      toolCallId: "call_img_empty",
      toolName: "image_search",
      input: { query: "very obscure thing" },
      state: "output-available",
      output: {
        query: "very obscure thing",
        results: [],
      },
    } as unknown as ToolUIPart;

    render(<ImageGallery part={part} />);
    expect(screen.getByText(/No images found for/i)).toBeInTheDocument();
  });

  it("renders image cards with source attribution and alt text", () => {
    const part: ToolUIPart = {
      type: "tool-invocation",
      toolCallId: "call_img_success",
      toolName: "image_search",
      input: { query: "RTX 5090" },
      state: "output-available",
      output: {
        query: "RTX 5090",
        results: [
          {
            title: "GeForce RTX 5090 Graphics Card",
            image_url: "https://images.example.com/rtx5090.jpg",
            source_url: "https://www.nvidia.com/5090",
            source_name: "nvidia.com",
            alt_text: "NVIDIA RTX 5090 GPU",
            width: 1920,
            height: 1080,
            rank: 1,
          },
        ],
      },
    } as unknown as ToolUIPart;

    render(<ImageGallery part={part} />);

    const img = screen.getByRole("img", { name: /NVIDIA RTX 5090 GPU/i });
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "https://images.example.com/rtx5090.jpg");

    const sourceLink = screen.getByRole("link", { name: /nvidia\.com/i });
    expect(sourceLink).toBeInTheDocument();
    expect(sourceLink).toHaveAttribute("href", "https://www.nvidia.com/5090");
    expect(sourceLink).toHaveAttribute("target", "_blank");
    expect(sourceLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("gracefully switches to fallback placeholder when an image fails to load", () => {
    const part: ToolUIPart = {
      type: "tool-invocation",
      toolCallId: "call_img_broken",
      toolName: "image_search",
      input: { query: "broken image" },
      state: "output-available",
      output: {
        query: "broken image",
        results: [
          {
            title: "Broken Link",
            image_url: "https://images.example.com/broken.jpg",
            source_url: "https://example.com",
            source_name: "example.com",
            rank: 1,
          },
        ],
      },
    } as unknown as ToolUIPart;

    render(<ImageGallery part={part} />);

    const img = screen.getByRole("img", { name: /Broken Link/i });
    // Trigger image error
    fireEvent.error(img);

    expect(screen.getByText(/Image unavailable/i)).toBeInTheDocument();
  });

  it("opens lightbox dialog on image click with preview details", async () => {
    const part: ToolUIPart = {
      type: "tool-invocation",
      toolCallId: "call_img_modal",
      toolName: "image_search",
      input: { query: "Eiffel Tower" },
      state: "output-available",
      output: {
        query: "Eiffel Tower",
        results: [
          {
            title: "Eiffel Tower Paris Official Photo",
            image_url: "https://images.example.com/eiffel.jpg",
            source_url: "https://toureiffel.paris",
            source_name: "toureiffel.paris",
            alt_text: "Eiffel Tower in Paris",
            width: 1920,
            height: 1080,
            rank: 1,
          },
        ],
      },
    } as unknown as ToolUIPart;

    render(<ImageGallery part={part} />);

    const cardButton = screen.getByRole("button", {
      name: /Preview Eiffel Tower Paris Official Photo/i,
    });
    fireEvent.click(cardButton);

    // Dialog should open
    expect(
      await screen.findByRole("dialog")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1920 × 1080/i)
    ).toBeInTheDocument();
  });

  it("caps normal displayed images to at most 2 even if provider returned more", () => {
    const part: ToolUIPart = {
      type: "tool-invocation",
      toolCallId: "call_many",
      toolName: "image_search",
      input: { query: "tube computers" },
      state: "output-available",
      output: {
        query: "tube computers",
        results: [
          {
            title: "Computer 1",
            image_url: "https://example.com/c1.jpg",
            source_name: "archive.org",
            rank: 1,
          },
          {
            title: "Computer 2",
            image_url: "https://example.com/c2.jpg",
            source_name: "si.edu",
            rank: 2,
          },
          {
            title: "Computer 3",
            image_url: "https://example.com/c3.jpg",
            source_name: "loc.gov",
            rank: 3,
          },
          {
            title: "Computer 4",
            image_url: "https://example.com/c4.jpg",
            source_name: "museum.org",
            rank: 4,
          },
        ],
      },
    } as unknown as ToolUIPart;

    render(<ImageGallery part={part} />);

    // Only 2 images should be rendered
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(2);
    expect(screen.getByRole("img", { name: /Computer 1/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Computer 2/i })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Computer 3/i })).not.toBeInTheDocument();
  });

  it("collapses gracefully to 1 working image when one fails in a 2-image response", () => {
    const part: ToolUIPart = {
      type: "tool-invocation",
      toolCallId: "call_fail_one",
      toolName: "image_search",
      input: { query: "RTX 5090" },
      state: "output-available",
      output: {
        query: "RTX 5090",
        results: [
          {
            title: "RTX 5090 Working Image",
            image_url: "https://nvidia.com/working.jpg",
            source_name: "nvidia.com",
            rank: 1,
          },
          {
            title: "RTX 5090 Broken Image",
            image_url: "https://broken.com/broken.jpg",
            source_name: "broken.com",
            rank: 2,
          },
        ],
      },
    } as unknown as ToolUIPart;

    render(<ImageGallery part={part} />);

    expect(screen.getAllByRole("img")).toHaveLength(2);

    // Trigger error on the broken image
    const brokenImg = screen.getByRole("img", { name: /RTX 5090 Broken Image/i });
    fireEvent.error(brokenImg);

    // Broken image card should collapse away, leaving only the 1 working image
    const remainingImages = screen.getAllByRole("img");
    expect(remainingImages).toHaveLength(1);
    expect(screen.getByRole("img", { name: /RTX 5090 Working Image/i })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /RTX 5090 Broken Image/i })).not.toBeInTheDocument();
  });
});
