import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomToolsTab } from "../custom-tools-tab";

describe("CustomToolsTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  const mockTool = {
    id: "ctool_1",
    name: "weather_tool",
    description: "Weather fetcher",
    enabled: true,
    schema: {
      type: "object",
      properties: {
        city: {
          type: "string",
          description: "City name",
        },
        units: {
          type: "string",
          description: "Metric or imperial",
        },
      },
      required: ["city"],
    },
    execution: {
      type: "http",
      url: "https://api.weather.test/v1?city={city}",
      method: "GET",
      headers: {
        Authorization: "••••••••",
      },
      timeoutMs: 10000,
      hasSecrets: true,
    },
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };

  it("renders list of custom tools and displays create button", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          tools: [mockTool],
        }),
        { status: 200 }
      )
    );

    render(<CustomToolsTab />);

    await waitFor(() => {
      expect(screen.getByText("weather_tool")).toBeInTheDocument();
    });
    expect(screen.getByText("Weather fetcher")).toBeInTheDocument();
    expect(screen.getByText("GET")).toBeInTheDocument();
    expect(screen.getByText("https://api.weather.test/v1?city={city}")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new tool/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /test/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete/i })).toBeInTheDocument();
  });

  it("toggles tool enabled state", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ tools: [mockTool] }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ tool: { ...mockTool, enabled: false } }),
          { status: 200 }
        )
      );

    render(<CustomToolsTab />);

    await waitFor(() => {
      expect(screen.getByText("weather_tool")).toBeInTheDocument();
    });

    const toggleSwitch = screen.getByRole("switch");
    expect(toggleSwitch).toBeChecked();

    await user.click(toggleSwitch);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/custom-tools/ctool_1",
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"enabled":false'),
        })
      );
    });
  });

  it("deletes a custom tool after confirmation", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ tools: [mockTool] }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, id: "ctool_1" }),
          { status: 200 }
        )
      );

    render(<CustomToolsTab />);

    await waitFor(() => {
      expect(screen.getByText("weather_tool")).toBeInTheDocument();
    });

    const deleteBtn = screen.getByRole("button", { name: /delete/i });
    await user.click(deleteBtn);

    expect(confirmSpy).toHaveBeenCalledWith("Are you sure you want to delete this custom tool?");

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/custom-tools/ctool_1",
        expect.objectContaining({
          method: "DELETE",
        })
      );
    });

    await waitFor(() => {
      expect(screen.queryByText("weather_tool")).not.toBeInTheDocument();
    });
  });

  it("does not delete a custom tool when confirmation is canceled", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ tools: [mockTool] }),
        { status: 200 }
      )
    );

    render(<CustomToolsTab />);

    await waitFor(() => {
      expect(screen.getByText("weather_tool")).toBeInTheDocument();
    });

    const deleteBtn = screen.getByRole("button", { name: /delete/i });
    await user.click(deleteBtn);

    expect(confirmSpy).toHaveBeenCalledWith("Are you sure you want to delete this custom tool?");
    expect(fetchSpy).toHaveBeenCalledTimes(1); // Only the initial GET fetch
    expect(screen.getByText("weather_tool")).toBeInTheDocument();
  });

  it("creates a new custom tool through dialog", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ tools: [] }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tool: {
              id: "ctool_2",
              name: "stock_lookup",
              description: "Look up stock quotes",
              enabled: true,
              schema: { type: "object", properties: { symbol: { type: "string" } } },
              execution: {
                type: "http",
                url: "https://api.stocks.test/{symbol}",
                method: "GET",
                timeoutMs: 10000,
              },
            },
          }),
          { status: 201 }
        )
      );

    render(<CustomToolsTab />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /new tool/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /new tool/i }));

    expect(screen.getByText("Create Custom Tool")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/name/i), "stock_lookup");
    await user.type(screen.getByLabelText(/description/i), "Look up stock quotes");
    await user.type(screen.getByLabelText(/url/i), "https://api.stocks.test/{symbol}");

    await user.click(screen.getByRole("button", { name: /save tool/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/custom-tools",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"name":"stock_lookup"'),
        })
      );
    });
  });

  it("edits an existing custom tool through dialog", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ tools: [mockTool] }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tool: {
              ...mockTool,
              description: "Updated weather description",
            },
          }),
          { status: 200 }
        )
      );

    render(<CustomToolsTab />);

    await waitFor(() => {
      expect(screen.getByText("weather_tool")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /edit/i }));

    expect(screen.getByText("Edit Custom Tool: weather_tool")).toBeInTheDocument();

    const descInput = screen.getByLabelText(/description/i);
    await user.clear(descInput);
    await user.type(descInput, "Updated weather description");

    await user.click(screen.getByRole("button", { name: /save tool/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/custom-tools/ctool_1",
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"description":"Updated weather description"'),
        })
      );
    });
  });

  it("opens test drawer, displays network warning banner, renders parameter inputs, and executes test", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ tools: [mockTool] }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 200,
            durationMs: 45,
            data: { temp: 72, condition: "Sunny" },
          }),
          { status: 200 }
        )
      );

    render(<CustomToolsTab />);

    await waitFor(() => {
      expect(screen.getByText("weather_tool")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /test/i }));

    // Warning banner check
    expect(
      screen.getByText(/This fires a real network request to the target endpoint/i)
    ).toBeInTheDocument();

    // Auto-generated property inputs
    expect(screen.getByLabelText(/city/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/units/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/city/i), "Tokyo");

    // Execute test run
    await user.click(screen.getByRole("button", { name: /run test/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/custom-tools/ctool_1/test",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ city: "Tokyo" }),
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByText(/"temp": 72/i)).toBeInTheDocument();
    });
  });
});
