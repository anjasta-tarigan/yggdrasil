import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolsTab, type ToolsTabProps } from "../tools-tab";

afterEach(() => {
  cleanup();
});

const generateMockTools = (count: number) => {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${i + 1}`,
    description: `Description for tool ${i + 1}`,
    configured: true,
    requires: null,
    enabled: true,
    disableable: true,
  }));
};

const defaultProps: ToolsTabProps = {
  tools: generateMockTools(15),
  webSearch: {
    providers: [],
    chain: [],
  },
  wsForm: {
    searxng: { enabled: false, apiKey: "", baseUrl: "" },
    firecrawl: { enabled: false, apiKey: "", baseUrl: "" },
    exa: { enabled: false, apiKey: "", baseUrl: "" },
  },
  updateWsForm: vi.fn(),
  wsSaved: false,
  wsSaveError: null,
  saveWebSearch: vi.fn().mockResolvedValue(undefined),
  toggleTool: vi.fn(),
  toolsSaved: false,
  toolsSaveError: null,
};

describe("ToolsTab Pagination", () => {
  it("renders first page with default page size of 6 and pagination controls", () => {
    render(<ToolsTab {...defaultProps} />);

    expect(screen.getByText("Chat tools")).toBeInTheDocument();
    expect(screen.getByText("(15)")).toBeInTheDocument();

    // First page contains tool_1 to tool_6
    expect(screen.getByText("tool_1")).toBeInTheDocument();
    expect(screen.getByText("tool_6")).toBeInTheDocument();
    expect(screen.queryByText("tool_7")).not.toBeInTheDocument();

    // Pagination info
    expect(screen.getByTestId("tools-pagination")).toBeInTheDocument();
    expect(screen.getByText(/Showing/)).toBeInTheDocument();
    expect(screen.getByText("15")).toBeInTheDocument();

    // Page 1 is active
    const page1Btn = screen.getByRole("button", { name: "Go to page 1 of tools" });
    expect(page1Btn).toHaveAttribute("aria-current", "page");

    // Prev/first disabled on page 1
    expect(screen.getByRole("button", { name: "First page of tools" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous page of tools" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page of tools" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Last page of tools" })).not.toBeDisabled();
  });

  it("navigates to next and previous pages", async () => {
    render(<ToolsTab {...defaultProps} />);

    const nextBtn = screen.getByRole("button", { name: "Next page of tools" });
    await userEvent.click(nextBtn);

    // Page 2 contains tool_7 to tool_12
    expect(screen.queryByText("tool_1")).not.toBeInTheDocument();
    expect(screen.getByText("tool_7")).toBeInTheDocument();
    expect(screen.getByText("tool_12")).toBeInTheDocument();
    expect(screen.queryByText("tool_13")).not.toBeInTheDocument();

    const prevBtn = screen.getByRole("button", { name: "Previous page of tools" });
    await userEvent.click(prevBtn);

    // Back to page 1
    expect(screen.getByText("tool_1")).toBeInTheDocument();
    expect(screen.queryByText("tool_7")).not.toBeInTheDocument();
  });

  it("navigates directly to last page and first page", async () => {
    render(<ToolsTab {...defaultProps} />);

    const lastBtn = screen.getByRole("button", { name: "Last page of tools" });
    await userEvent.click(lastBtn);

    // Last page (page 3 for 15 items with pageSize 6) has tool_13 to tool_15
    expect(screen.getByText("tool_13")).toBeInTheDocument();
    expect(screen.getByText("tool_15")).toBeInTheDocument();
    expect(screen.queryByText("tool_1")).not.toBeInTheDocument();

    // Next/last disabled on last page
    expect(screen.getByRole("button", { name: "Next page of tools" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Last page of tools" })).toBeDisabled();

    // Go to first page
    const firstBtn = screen.getByRole("button", { name: "First page of tools" });
    await userEvent.click(firstBtn);
    expect(screen.getByText("tool_1")).toBeInTheDocument();
  });

  it("resets to page 1 when filter input changes", async () => {
    render(<ToolsTab {...defaultProps} />);

    // Advance to page 2
    await userEvent.click(screen.getByRole("button", { name: "Next page of tools" }));
    expect(screen.getByText("tool_7")).toBeInTheDocument();

    // Filter tools
    const filterInput = screen.getByLabelText("Filter tools");
    await userEvent.type(filterInput, "tool_15");

    // Immediately on page 1 with filtered item
    expect(screen.getByText("tool_15")).toBeInTheDocument();
    expect(screen.queryByText("tool_7")).not.toBeInTheDocument();
  });

  it("changes page size when per-page options clicked", async () => {
    render(<ToolsTab {...defaultProps} />);

    // Initially 6 per page
    expect(screen.queryByText("tool_7")).not.toBeInTheDocument();

    // Click '12' per page
    const size12Btn = screen.getByRole("button", { name: "12" });
    await userEvent.click(size12Btn);

    // Now page 1 displays up to 12 tools
    expect(screen.getByText("tool_1")).toBeInTheDocument();
    expect(screen.getByText("tool_12")).toBeInTheDocument();
    expect(screen.queryByText("tool_13")).not.toBeInTheDocument();
  });
});
