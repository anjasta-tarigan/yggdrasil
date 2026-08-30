import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PageView } from "@/components/app-shell/page-view";

describe("PageView", () => {
  it("renders the title and a Back to chat button that calls onBack", () => {
    const onBack = vi.fn();
    render(
      <PageView title="Settings" onBack={onBack}>
        <p>content</p>
      </PageView>
    );
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /back to chat/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renders children inside the scrollable content region", () => {
    render(
      <PageView title="MCP Servers" onBack={() => {}}>
        <div data-testid="inner">inner</div>
      </PageView>
    );
    expect(screen.getByTestId("inner")).toBeInTheDocument();
  });

  it("renders an optional description and actions cluster", () => {
    render(
      <PageView
        actions={<button type="button">Refresh</button>}
        description="Specialized assistants"
        onBack={() => {}}
        title="Subagents"
      >
        <p>body</p>
      </PageView>
    );
    expect(screen.getByText("Specialized assistants")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });
});
