import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { UpdateCheck } from "../UpdateCheck";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("UpdateCheck component", () => {
  it("renders update available banner when update is available and not dismissed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/system/update-check")) {
        return new Response(
          JSON.stringify({
            current: "0.1.0",
            latest: "0.2.0",
            available: true,
            channel: "release",
            releaseUrl:
              "https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.2.0",
            dismissed: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(null, { status: 404 });
    });

    render(<UpdateCheck />);

    await waitFor(() => {
      expect(screen.getByText(/Update v0.2.0 available/i)).toBeInTheDocument();
    });

    const link = screen.getByRole("link", { name: /view/i });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/anjasta-tarigan/yggdrasil/releases/tag/v0.2.0"
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders nothing when up to date or already dismissed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          current: "0.2.0",
          latest: "0.2.0",
          available: false,
          dismissed: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const { container } = render(<UpdateCheck />);
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("calls dismiss API and hides the banner when Dismiss is clicked", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: unknown, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (method === "POST") {
          return new Response(JSON.stringify({ ok: true, dismissed: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            current: "0.1.0",
            latest: "0.2.0",
            available: true,
            channel: "release",
            releaseUrl: "https://github.com/release/v0.2.0",
            dismissed: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<UpdateCheck />);

    await waitFor(() => {
      expect(screen.getByText(/Update v0.2.0 available/i)).toBeInTheDocument();
    });

    const dismissBtn = screen.getByRole("button", { name: /dismiss/i });
    fireEvent.click(dismissBtn);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/system/update-check",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "dismiss" }),
        })
      );
      expect(
        screen.queryByText(/Update v0.2.0 available/i)
      ).not.toBeInTheDocument();
    });
  });
});
