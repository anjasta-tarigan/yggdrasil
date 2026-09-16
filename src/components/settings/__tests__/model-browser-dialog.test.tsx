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

    const searchInput = await screen.findByPlaceholderText(/filter/i);
    fireEvent.change(searchInput, { target: { value: "bge" } });

    const searchButton = screen.getByRole("button", { name: /search/i });
    fireEvent.click(searchButton);

    await waitFor(() => {
      expect(screen.getByText("test/model-a")).toBeInTheDocument();
      expect(screen.getByText("test/model-b")).toBeInTheDocument();
    });
  });

  it("handles 404 cleanly when polling install job without running away", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/models/search")) {
        return {
          ok: true,
          json: async () => ({
            results: [{ id: "test/model-a", downloads: 10, likes: 2 }],
          }),
        };
      }
      if (url.includes("/api/models/inspect")) {
        return {
          ok: true,
          json: async () => ({
            plan: {
              repo: "test/model-a",
              totalBytes: 1000,
              files: [{ destinationRelPath: "model.onnx", sizeBytes: 1000, role: "graph" }],
            },
          }),
        };
      }
      if (url.endsWith("/api/models/install")) {
        return {
          ok: true,
          json: async () => ({ jobId: "job_test_404" }),
        };
      }
      if (url.includes("/api/models/install/job_test_404")) {
        return {
          status: 404,
          ok: false,
          json: async () => ({ error: "not found" }),
        };
      }
      return { ok: false, status: 500 };
    });

    render(<ModelBrowserDialog kind="embedding" onInstalled={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /add model|browse huggingface/i }));

    const searchInput = await screen.findByPlaceholderText(/filter/i);
    fireEvent.change(searchInput, { target: { value: "bge" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    const inspectBtn = await screen.findByRole("button", { name: /inspect/i });
    fireEvent.click(inspectBtn);

    const installBtn = await screen.findByRole("button", { name: /install/i });
    fireEvent.click(installBtn);

    await waitFor(() => {
      expect(screen.getByText(/installation job not found/i)).toBeInTheDocument();
    });
  });

  it("completes install when polling status is completed", async () => {
    const onInstalled = vi.fn();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/models/search")) {
        return {
          ok: true,
          json: async () => ({
            results: [{ id: "test/model-a", downloads: 10, likes: 2 }],
          }),
        };
      }
      if (url.includes("/api/models/inspect")) {
        return {
          ok: true,
          json: async () => ({
            plan: {
              repo: "test/model-a",
              totalBytes: 1000,
              files: [{ destinationRelPath: "model.onnx", sizeBytes: 1000, role: "graph" }],
            },
          }),
        };
      }
      if (url.endsWith("/api/models/install")) {
        return {
          ok: true,
          json: async () => ({ jobId: "job_test_done" }),
        };
      }
      if (url.includes("/api/models/install/job_test_done")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            status: "completed",
            bytesDownloaded: 1000,
            estimatedBytes: 1000,
          }),
        };
      }
      return { ok: false, status: 500 };
    });

    render(<ModelBrowserDialog kind="embedding" onInstalled={onInstalled} />);
    fireEvent.click(screen.getByRole("button", { name: /add model|browse huggingface/i }));

    const searchInput = await screen.findByPlaceholderText(/filter/i);
    fireEvent.change(searchInput, { target: { value: "bge" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    const inspectBtn = await screen.findByRole("button", { name: /inspect/i });
    fireEvent.click(inspectBtn);

    const installBtn = await screen.findByRole("button", { name: /install/i });
    fireEvent.click(installBtn);

    await waitFor(() => {
      expect(onInstalled).toHaveBeenCalledWith("test/model-a");
    });
  });

  it("triggers search when clicking a suggestion chip", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ id: "Xenova/all-MiniLM-L6-v2", downloads: 5000, likes: 120 }],
      }),
    });

    render(<ModelBrowserDialog kind="embedding" onInstalled={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /add model|browse huggingface/i }));

    // The chip is the only button carrying that exact label (results render the
    // id as text, not as a button).
    const chip = await screen.findByRole("button", { name: "Xenova/all-MiniLM-L6-v2" });
    fireEvent.click(chip);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("q=Xenova%2Fall-MiniLM-L6-v2"),
      );
    });
    expect(await screen.findAllByText("Xenova/all-MiniLM-L6-v2")).not.toHaveLength(0);
  });

  it("auto-loads the ranked catalog when the dialog opens", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { id: "Xenova/all-MiniLM-L6-v2", downloads: 2793335, likes: 147, rank: 1 },
          { id: "mixedbread-ai/mxbai-embed-large-v1", downloads: 2547500, likes: 825, rank: 2 },
        ],
      }),
    });

    render(<ModelBrowserDialog kind="embedding" onInstalled={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /add model|browse huggingface/i }));

    // Browsing must fire without any typed query.
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/models/search?q=&kind=embedding"),
      );
    });
    expect(await screen.findAllByText("Xenova/all-MiniLM-L6-v2")).not.toHaveLength(0);
    expect(screen.getByText(/Top ONNX models by downloads/)).toBeInTheDocument();
  });

  it("pages the catalog via Show more and requests a larger limit", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/models/search")) {
        // Return a full page so the component believes more models exist.
        const isSecondPage = url.includes("limit=120");
        const count = isSecondPage ? 120 : 60;
        return {
          ok: true,
          json: async () => ({
            results: Array.from({ length: count }, (_, i) => ({
              id: `org/model-${i}`,
              downloads: 1000 - i,
              likes: 0,
              rank: i + 1,
            })),
          }),
        };
      }
      return { ok: false, status: 500 };
    });

    render(<ModelBrowserDialog kind="embedding" onInstalled={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /add model|browse huggingface/i }));

    // First page requests the default page size.
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("limit=60"));
    });

    const showMore = await screen.findByRole("button", { name: /show more models/i });
    fireEvent.click(showMore);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("limit=120"));
    });
  });
});
