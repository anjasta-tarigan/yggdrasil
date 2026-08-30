import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsRow } from "@/components/settings/settings-row";

describe("SettingsRow", () => {
  it("renders label, description and control", () => {
    render(
      <SettingsRow label="Welcome" description="Shown on first launch" control={<button>Save</button>} />
    );
    expect(screen.getByText("Welcome")).toBeInTheDocument();
    expect(screen.getByText("Shown on first launch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("renders without an optional description", () => {
    render(<SettingsRow label="Only label" control={<span>ctrl</span>} />);
    expect(screen.getByText("Only label")).toBeInTheDocument();
    expect(screen.getByText("ctrl")).toBeInTheDocument();
  });
});