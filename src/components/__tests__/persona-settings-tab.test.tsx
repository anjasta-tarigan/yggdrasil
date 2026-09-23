import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PersonaTab } from "@/components/settings/persona-tab";
import { DEFAULT_SYSTEM_PERSONA } from "@/lib/persona/types";

afterEach(() => {
  cleanup();
});

describe("<PersonaTab />", () => {
  const initialPersona = {
    name: "Architect",
    instructions: "Write clean code.",
    updatedAt: 1000,
  };

  it("renders persona name and instructions inputs", () => {
    render(
      <PersonaTab
        persona={initialPersona}
        defaultPersona={DEFAULT_SYSTEM_PERSONA}
        onSave={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(screen.getByLabelText(/Persona Name/i)).toHaveValue("Architect");
    expect(screen.getByLabelText(/System Instructions/i)).toHaveValue("Write clean code.");
    expect(screen.getByText(/~5 tokens/i)).toBeInTheDocument();
  });

  it("updates token estimation live when typing in instructions", async () => {
    const user = userEvent.setup();
    render(
      <PersonaTab
        persona={{ name: "", instructions: "", updatedAt: 0 }}
        defaultPersona={DEFAULT_SYSTEM_PERSONA}
        onSave={vi.fn()}
        onReset={vi.fn()}
      />
    );

    const textarea = screen.getByLabelText(/System Instructions/i);
    await user.type(textarea, "12345678"); // 8 chars = ~2 tokens
    expect(screen.getByText(/~2 tokens/i)).toBeInTheDocument();
  });

  it("calls onSave with updated values when clicking Save", async () => {
    const user = userEvent.setup();
    const handleSave = vi.fn().mockResolvedValue(true);

    render(
      <PersonaTab
        persona={initialPersona}
        defaultPersona={DEFAULT_SYSTEM_PERSONA}
        onSave={handleSave}
        onReset={vi.fn()}
      />
    );

    const nameInput = screen.getByLabelText(/Persona Name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "New Lead");

    const saveButton = screen.getByRole("button", { name: /Save Persona/i });
    await user.click(saveButton);

    expect(handleSave).toHaveBeenCalledWith({
      name: "New Lead",
      instructions: "Write clean code.",
    });
  });

  it("calls onReset when clicking Reset to Default", async () => {
    const user = userEvent.setup();
    const handleReset = vi.fn().mockResolvedValue(true);

    render(
      <PersonaTab
        persona={initialPersona}
        defaultPersona={DEFAULT_SYSTEM_PERSONA}
        onSave={vi.fn()}
        onReset={handleReset}
      />
    );

    const resetButton = screen.getByRole("button", { name: /Reset to Default/i });
    await user.click(resetButton);

    // Destructive reset is gated behind a confirmation dialog; confirm it.
    const confirmButtons = screen.getAllByRole("button", { name: /Reset to Default/i });
    await user.click(confirmButtons[confirmButtons.length - 1]);

    expect(handleReset).toHaveBeenCalled();
  });
});
