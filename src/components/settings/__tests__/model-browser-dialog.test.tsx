import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const mockFetch = vi.fn();

vi.stubGlobal("fetch", mockFetch);

import { ModelBrowserDialog } from "../model-browser-dialog";

describe("ModelBrowserDialog", () => {
  beforeEach(() => {
    cleanup();
    mockFetch.mockReset();
  });

  it("renders search input and trigger button", () => {
    render(<ModelBrowserDialog kind="embedding" onInstalled={() => {}} />);
    expect(
      screen.getByRole("button", { name: /add model|browse huggingface/i }),
    ).toBeInTheDocument();
  });

  it("fetches and displays search results after searching", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { id: "test/model-a", downloads: 10, likes: 2 },
          { id: "test/model-b", downloads: 5, likes: 1 },
        ],
      }),
    });

    render(<ModelBrowserDialog kind="embedding" onInstalled={() => {}} />);
    const dialogTrigger = screen.getByRole("button", {
      name: /add model|browse huggingface/i,
    });
    fireEvent.click(dialogTrigger);

    const searchInput = await screen.findByPlaceholderText(/search/i);
    fireEvent.change(searchInput, { target: { value: "bge" } });

    const searchButton = screen.getByRole("button", { name: /search/i });
    fireEvent.click(searchButton);

    await waitFor(() => {
      expect(screen.getByText("test/model-a")).toBeInTheDocument();
      expect(screen.getByText("test/model-b")).toBeInTheDocument();
    });
  });
});
