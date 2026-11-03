import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GgufAddDialog } from "../gguf-add-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderDialog(
  overrides: Partial<Parameters<typeof GgufAddDialog>[0]> = {},
) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    busy: false,
    error: null as string | null,
    serverFound: true as boolean | null,
    serverPath: "/usr/local/bin/llama-server" as string | null,
    serverVersion: 4321 as number | null,
    models: [
      { filename: "qwen2.5-7b.gguf", path: "/models/qwen2.5-7b.gguf", sizeBytes: 4_400_000_000, fitsMemory: true },
    ],
    customServerPath: "",
    onCustomServerPathChange: vi.fn(),
    selectedModels: new Set<string>(),
    onSelectedModelsChange: vi.fn(),
    onReprobe: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
  render(<GgufAddDialog {...props} />);
  return props;
}

describe("GgufAddDialog", () => {
  it("reports the probe while it is running", () => {
    renderDialog({ busy: true, serverFound: null });

    expect(screen.getByText("Probing for llama-server…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("shows the detected binary and build number", () => {
    renderDialog();

    expect(screen.getByText("llama-server detected")).toBeInTheDocument();
    expect(screen.getByText("/usr/local/bin/llama-server")).toBeInTheDocument();
    expect(screen.getByText("llama-server build 4321")).toBeInTheDocument();
  });

  it("offers the install banner and re-probes a manual path", () => {
    const props = renderDialog({ serverFound: false, serverPath: null, serverVersion: null });

    expect(screen.getAllByText("llama-server not found").length).toBeGreaterThan(0);
    const reprobe = screen.getByRole("button", { name: "Re-probe" });
    expect(reprobe).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("/usr/local/bin/llama-server"), {
      target: { value: "/opt/bin/llama-server" },
    });
    expect(props.onCustomServerPathChange).toHaveBeenCalledWith("/opt/bin/llama-server");
  });

  it("toggles model selection through the callback", () => {
    const onSelectedModelsChange = vi.fn<(next: Set<string>) => void>();
    renderDialog({ onSelectedModelsChange });

    fireEvent.click(screen.getByRole("checkbox"));
    expect(onSelectedModelsChange).toHaveBeenCalledTimes(1);
    const next = onSelectedModelsChange.mock.calls[0][0];
    expect([...next]).toEqual(["qwen2.5-7b.gguf"]);
  });

  it("flags models that exceed available memory", () => {
    renderDialog({
      models: [
        { filename: "huge.gguf", path: "/models/huge.gguf", sizeBytes: 92_000_000_000, fitsMemory: false },
      ],
    });

    expect(screen.getByText("over-memory")).toBeInTheDocument();
  });

  it("shows the empty state and keeps Add disabled", () => {
    renderDialog({ models: [] });

    expect(screen.getByText("No GGUF models found")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("enables Add and confirms once a model is selected", () => {
    const props = renderDialog({ selectedModels: new Set(["qwen2.5-7b.gguf"]) });

    const add = screen.getByRole("button", { name: "Add" });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("surfaces a probe error", () => {
    renderDialog({ serverFound: false, error: "Status probe failed (HTTP 500)" });

    expect(screen.getByText("Status probe failed (HTTP 500)")).toBeInTheDocument();
  });
});
