import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EmbeddingChangeDialog } from "../embedding-change-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderDialog(
  overrides: Partial<Parameters<typeof EmbeddingChangeDialog>[0]> = {},
) {
  const props = {
    modelChanged: "nomic-embed-text" as string | null,
    rebuildBusy: false,
    rebuildProgress: { current: 0, total: 0, percent: 0 },
    rebuildError: null as string | null,
    onDismiss: vi.fn(),
    onRebuild: vi.fn(),
    ...overrides,
  };
  render(<EmbeddingChangeDialog {...props} />);
  return props;
}

describe("EmbeddingChangeDialog", () => {
  it("stays closed when no model change is pending", () => {
    renderDialog({ modelChanged: null });

    expect(screen.queryByText("Rebuild embeddings?")).not.toBeInTheDocument();
  });

  it("names the new model and offers both actions", () => {
    const props = renderDialog();

    expect(screen.getByText("Rebuild embeddings?")).toBeInTheDocument();
    expect(screen.getByText(/nomic-embed-text/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rebuild now" }));
    expect(props.onRebuild).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows a preparing state once the rebuild starts", () => {
    renderDialog({ rebuildBusy: true });

    expect(screen.getByTestId("rebuild-progress")).toBeInTheDocument();
    expect(screen.getByText("Preparing…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rebuilding…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDisabled();
  });

  it("reports concrete rebuild progress", () => {
    renderDialog({
      rebuildBusy: true,
      rebuildProgress: { current: 3, total: 10, percent: 30 },
    });

    expect(screen.getByText("3 / 10 (30%)")).toBeInTheDocument();
  });

  it("surfaces a rebuild failure", () => {
    renderDialog({ rebuildError: "embedding provider unreachable" });

    expect(screen.getByText("Rebuild Failed")).toBeInTheDocument();
    expect(screen.getByText("embedding provider unreachable")).toBeInTheDocument();
  });
});
