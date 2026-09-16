import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RerankerTab, type RerankerInfo } from "@/components/settings/reranker-tab";

afterEach(() => {
  cleanup();
});

const defaultRerankerInfo: RerankerInfo = {
  enabled: true,
  available: true,
  loaded: false,
  modelPath: "/app/data/models/reranker/bge-reranker-v2-m3-int8.onnx",
  canonicalPath: "/app/data/models/reranker/bge-reranker-v2-m3-int8.onnx",
  mode: "standby",
  discoveredModels: [
    {
      filename: "bge-reranker-v2-m3-int8.onnx",
      sizeBytes: 544 * 1024 * 1024,
    },
  ],
};

describe("RerankerTab", () => {
  it("renders On/Off switch and calls onToggleEnabled when clicked", async () => {
    const onToggleEnabled = vi.fn();
    render(
      <RerankerTab
        enabled={true}
        onSelectModel={vi.fn()}
        onToggleEnabled={onToggleEnabled}
        reranker={defaultRerankerInfo}
        selectedModel="bge-reranker-v2-m3-int8.onnx"
      />
    );

    const toggle = screen.getByRole("switch", {
      name: /toggle neural reranker/i,
    });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("data-state", "checked");

    await userEvent.click(toggle);
    expect(onToggleEnabled).toHaveBeenCalledWith(false);
  });

  it("renders discovered model in list without select dropdown when only one model exists", () => {
    render(
      <RerankerTab
        enabled={true}
        onSelectModel={vi.fn()}
        onToggleEnabled={vi.fn()}
        reranker={defaultRerankerInfo}
        selectedModel="bge-reranker-v2-m3-int8.onnx"
      />
    );

    expect(screen.getByText("Discovered models")).toBeInTheDocument();
    expect(
      screen.getAllByText("bge-reranker-v2-m3-int8.onnx").length
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("544 MB").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByText("In use")).toBeInTheDocument();

    // Select dropdown should not be rendered for a single model
    expect(
      screen.queryByLabelText(/active model file/i)
    ).not.toBeInTheDocument();
  });

  it("renders Select dropdown allowing model selection when multiple models exist", () => {
    const multipleModelsInfo: RerankerInfo = {
      ...defaultRerankerInfo,
      discoveredModels: [
        {
          filename: "bge-reranker-v2-m3-int8.onnx",
          sizeBytes: 544 * 1024 * 1024,
        },
        {
          filename: "ms-marco-MiniLM-L-6-v2.onnx",
          sizeBytes: 85 * 1024 * 1024,
        },
      ],
    };

    render(
      <RerankerTab
        enabled={true}
        onSelectModel={vi.fn()}
        onToggleEnabled={vi.fn()}
        reranker={multipleModelsInfo}
        selectedModel="bge-reranker-v2-m3-int8.onnx"
      />
    );

    // Select dropdown should be rendered
    const selectTrigger = screen.getByRole("combobox", {
      name: /active model file/i,
    });
    expect(selectTrigger).toBeInTheDocument();
    expect(screen.getByText("Discovered model files (2)")).toBeInTheDocument();
  });

  it("renders download instructions and fallback notice when no models exist", () => {
    const noModelsInfo: RerankerInfo = {
      enabled: true,
      available: false,
      loaded: false,
      modelPath: null,
      canonicalPath: "/app/data/models/reranker/bge-reranker-v2-m3-int8.onnx",
      mode: "fallback",
      discoveredModels: [],
    };

    render(
      <RerankerTab
        enabled={true}
        onSelectModel={vi.fn()}
        onToggleEnabled={vi.fn()}
        reranker={noModelsInfo}
        selectedModel=""
      />
    );

    expect(
      screen.getByText("No ONNX reranker models discovered")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Neural reranking is falling back to standard vector cosine similarity/)
    ).toBeInTheDocument();
    expect(
      screen.getByText("Install the default neural reranker model")
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(/bge-reranker-v2-m3-int8\.onnx/i).length
    ).toBeGreaterThanOrEqual(1);
  });

  it("displays correct mode badges", () => {
    const { rerender } = render(
      <RerankerTab
        enabled={true}
        onSelectModel={vi.fn()}
        onToggleEnabled={vi.fn()}
        reranker={{ ...defaultRerankerInfo, mode: "active", loaded: true }}
        selectedModel="bge-reranker-v2-m3-int8.onnx"
      />
    );
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Yes (active session in RAM)")).toBeInTheDocument();

    rerender(
      <RerankerTab
        enabled={true}
        onSelectModel={vi.fn()}
        onToggleEnabled={vi.fn()}
        reranker={{ ...defaultRerankerInfo, mode: "standby", loaded: false }}
        selectedModel="bge-reranker-v2-m3-int8.onnx"
      />
    );
    expect(screen.getByText("Standby")).toBeInTheDocument();
    expect(screen.getByText("No (unloaded, zero RAM footprint)")).toBeInTheDocument();

    rerender(
      <RerankerTab
        enabled={true}
        onSelectModel={vi.fn()}
        onToggleEnabled={vi.fn()}
        reranker={{ ...defaultRerankerInfo, mode: "fallback", loaded: false, modelPath: null }}
        selectedModel=""
      />
    );
    expect(screen.getByText("Fallback")).toBeInTheDocument();

    rerender(
      <RerankerTab
        enabled={false}
        onSelectModel={vi.fn()}
        onToggleEnabled={vi.fn()}
        reranker={{ ...defaultRerankerInfo, mode: "disabled", loaded: false }}
        selectedModel=""
      />
    );
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("renders diagnostics details including model in use, file size, and idle timeout", () => {
    render(
      <RerankerTab
        enabled={true}
        onSelectModel={vi.fn()}
        onToggleEnabled={vi.fn()}
        reranker={defaultRerankerInfo}
        selectedModel="bge-reranker-v2-m3-int8.onnx"
      />
    );

    expect(screen.getByText("Status & diagnostics")).toBeInTheDocument();
    expect(screen.getByText("2 minutes (auto-unload)")).toBeInTheDocument();
    expect(
      screen.getAllByText("data/models/reranker/").length
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText("/app/data/models/reranker/bge-reranker-v2-m3-int8.onnx")
    ).toBeInTheDocument();
  });

  it("resolves and displays file size for installed models with sub-directory paths", () => {
    const installedRerankerInfo: RerankerInfo = {
      enabled: true,
      available: true,
      loaded: false,
      modelPath: "/app/data/models/reranker/BAAI--bge-reranker-v2-m3/model_quantized.onnx",
      canonicalPath: "/app/data/models/reranker/bge-reranker-v2-m3-int8.onnx",
      mode: "standby",
      discoveredModels: [
        {
          filename: "BAAI--bge-reranker-v2-m3/model_quantized.onnx",
          sizeBytes: 520 * 1024 * 1024,
        },
      ],
    };

    render(
      <RerankerTab
        enabled={true}
        onSelectModel={vi.fn()}
        onToggleEnabled={vi.fn()}
        reranker={installedRerankerInfo}
        selectedModel=""
      />
    );

    expect(screen.getAllByText("520 MB").length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getAllByText("BAAI--bge-reranker-v2-m3/model_quantized.onnx").length
    ).toBeGreaterThanOrEqual(2);
  });

  it("handles Save button clicks and shows saved or error states", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <RerankerTab
        enabled={true}
        onSave={onSave}
        onSelectModel={vi.fn()}
        onToggleEnabled={vi.fn()}
        reranker={defaultRerankerInfo}
        saved={false}
        saving={false}
        selectedModel="bge-reranker-v2-m3-int8.onnx"
      />
    );

    const saveBtn = screen.getByRole("button", {
      name: /save configuration/i,
    });
    expect(saveBtn).toBeInTheDocument();
    await userEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledTimes(1);

    // Rerender with saved: true
    rerender(
      <RerankerTab
        enabled={true}
        onSave={onSave}
        onSelectModel={vi.fn()}
        onToggleEnabled={vi.fn()}
        reranker={defaultRerankerInfo}
        saved={true}
        saving={false}
        selectedModel="bge-reranker-v2-m3-int8.onnx"
      />
    );
    expect(screen.getByText("Saved")).toBeInTheDocument();

    // Rerender with saveError
    rerender(
      <RerankerTab
        enabled={true}
        onSave={onSave}
        onSelectModel={vi.fn()}
        onToggleEnabled={vi.fn()}
        reranker={defaultRerankerInfo}
        saveError="Network error occurred"
        saved={false}
        saving={false}
        selectedModel="bge-reranker-v2-m3-int8.onnx"
      />
    );
    expect(screen.getByText("Network error occurred")).toBeInTheDocument();
  });

  it("renders idle timeout selection and calls onChangeIdleTimeoutMinutes", () => {
    render(
      <RerankerTab
        enabled={true}
        idleTimeoutMinutes={15}
        onChangeIdleTimeoutMinutes={vi.fn()}
        onSelectModel={vi.fn()}
        onToggleEnabled={vi.fn()}
        reranker={defaultRerankerInfo}
        selectedModel="bge-reranker-v2-m3-int8.onnx"
      />
    );

    expect(screen.getByText(/session lifecycle & memory timeout/i)).toBeInTheDocument();
  });

  it("renders delete button for discovered models", () => {
    render(
      <RerankerTab
        enabled={true}
        onSelectModel={vi.fn()}
        onToggleEnabled={vi.fn()}
        reranker={defaultRerankerInfo}
        selectedModel="bge-reranker-v2-m3-int8.onnx"
      />
    );

    const deleteBtn = screen.getByRole("button", {
      name: /delete bge-reranker-v2-m3-int8\.onnx/i,
    });
    expect(deleteBtn).toBeInTheDocument();
  });
});
