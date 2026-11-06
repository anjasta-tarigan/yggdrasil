import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { usePersonaSettings } from "../hooks/use-persona-settings";
import { DEFAULT_SYSTEM_PERSONA } from "@/lib/persona/types";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("usePersonaSettings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads persona when opened", async () => {
    const custom = {
      name: "Custom Agent",
      instructions: "Be helpful and concise",
    };
    const def = {
      name: "Default Agent",
      instructions: "Default instructions",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ persona: custom, defaultPersona: def })
    );

    const { result } = renderHook(() =>
      usePersonaSettings({ open: true, settingsVersion: 0 })
    );

    await waitFor(() => {
      expect(result.current.persona).toEqual(custom);
    });
    expect(result.current.defaultPersona).toEqual(def);
    expect(result.current.personaDirty).toBe(false);
  });

  it("does not fetch persona when closed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const { result } = renderHook(() =>
      usePersonaSettings({ open: false, settingsVersion: 0 })
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.persona).toEqual(DEFAULT_SYSTEM_PERSONA);
  });

  it("saves persona and updates state", async () => {
    const updated = {
      name: "Updated",
      instructions: "New instructions",
    };

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ persona: updated }));

    const { result } = renderHook(() =>
      usePersonaSettings({ open: true, settingsVersion: 0 })
    );

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.handleSavePersona(updated);
    });

    expect(success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    expect(result.current.persona).toEqual(updated);
  });

  it("resets persona and updates state", async () => {
    const resetPersona = {
      name: "Reset Name",
      instructions: "Reset Instructions",
    };

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ persona: resetPersona }));

    const { result } = renderHook(() =>
      usePersonaSettings({ open: true, settingsVersion: 0 })
    );

    let success: boolean | undefined;
    await act(async () => {
      success = await result.current.handleResetPersona();
    });

    expect(success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/persona/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(result.current.persona).toEqual(resetPersona);
  });

  it("tracks dirty state via setPersonaDirty", () => {
    const { result } = renderHook(() =>
      usePersonaSettings({ open: false, settingsVersion: 0 })
    );

    act(() => {
      result.current.setPersonaDirty(true);
    });

    expect(result.current.personaDirty).toBe(true);
  });
});
