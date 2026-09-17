import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsView } from "@/components/settings-view";
import { getProviders, hydrateSettings, type ProviderConfig } from "@/lib/settings";

const baseUrl = "https://integrate.api.nvidia.com/v1";
let providers: ProviderConfig[];
let writes: Array<Record<string, unknown>>;
let rejectSave: boolean;

beforeEach(async () => {
  providers = [];
  writes = [];
  rejectSave = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/providers") {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string);
        writes.push(body);
        if (rejectSave) return Response.json({ error: "Unable to save credentials" }, { status: 400 });
        providers = body.providers.map((p: ProviderConfig) => ({
          ...p, apiKeyConfigured: true,
          apiKeys: p.apiKeys?.map((row) => ({ id: row.id, apiKeyEnv: `PROVIDER_NIM_${row.id}_API_KEY`, configured: true })),
        }));
      }
      return Response.json({ providers });
    }
    if (url === "/api/settings") return Response.json({ embedding: null, store: { providers }, tools: [] });
    return Response.json({}, { status: 404 });
  }));
  await hydrateSettings();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openProviders() {
  render(<SettingsView onBack={() => {}} />);
  await userEvent.click(screen.getByRole("tab", { name: "Providers" }));
}

describe("NVIDIA NIM settings", () => {
  it("adds password rows with stable ids and the fixed NIM preset", async () => {
    await openProviders();
    await userEvent.click(screen.getByRole("button", { name: "Add NVIDIA NIM" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByLabelText("Base URL")).toHaveValue(baseUrl);
    expect(dialog.getByLabelText("Base URL")).toHaveAttribute("readonly");
    expect(dialog.getByRole("button", { name: "Save provider" })).toBeDisabled();
    const first = dialog.getByLabelText("API key 1");
    expect(first).toHaveAttribute("type", "password");
    await userEvent.type(first, "first-secret");
    await userEvent.click(dialog.getByRole("button", { name: "Add API key" }));
    await userEvent.type(dialog.getByLabelText("API key 2"), "second-secret");
    await userEvent.click(dialog.getByRole("button", { name: "Remove API key 1" }));
    const remaining = dialog.getByLabelText("API key 1");
    const rowId = remaining.id;
    expect(remaining).toHaveValue("second-secret");
    await userEvent.click(dialog.getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const saved = (writes[0].providers as Array<Record<string, unknown>>)[0];
    expect(saved).toMatchObject({ preset: "nvidia-nim", kind: "openai-compatible", name: "NVIDIA NIM", baseUrl });
    expect(saved.apiKeys).toEqual([{ id: rowId.replace("nim-key-", ""), value: "second-secret" }]);
    expect(JSON.stringify(getProviders())).not.toContain("secret");
    expect(screen.getByRole("button", { name: "Edit NVIDIA NIM" })).toBeInTheDocument();
  });

  it("retains unchanged saved rows, replaces one and removes another", async () => {
    providers = [{ id: "nim", name: "NVIDIA NIM", preset: "nvidia-nim", kind: "openai-compatible", baseUrl, apiKeyConfigured: true, models: [],
      apiKeys: ["keep", "replace", "remove"].map((id) => ({ id, apiKeyEnv: `PROVIDER_NIM_${id}_API_KEY`, configured: true })),
    }];
    await openProviders();
    await userEvent.click(screen.getByRole("button", { name: "Edit NVIDIA NIM" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByLabelText("Base URL")).toHaveAttribute("readonly");
    expect(dialog.getByLabelText("API key 1")).toHaveValue("");
    await userEvent.type(dialog.getByLabelText("API key 2"), "replacement-secret");
    await userEvent.click(dialog.getByRole("button", { name: "Remove API key 3" }));
    await userEvent.click(dialog.getByRole("button", { name: "Add API key" }));
    await userEvent.type(dialog.getByLabelText("API key 3"), "new-secret");
    await userEvent.click(dialog.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    const saved = (writes[0].providers as Array<Record<string, unknown>>)[0];
    expect(saved.apiKeys).toEqual([{ id: "keep" }, { id: "replace", value: "replacement-secret" }, { id: expect.any(String), value: "new-secret" }]);
    await userEvent.click(screen.getByRole("button", { name: "Edit NVIDIA NIM" }));
    expect(screen.getByLabelText("API key 2")).toHaveValue("");
  });

  it("limits the form to twenty keys and keeps at least one row", async () => {
    await openProviders();
    await userEvent.click(screen.getByRole("button", { name: "Add NVIDIA NIM" }));
    expect(screen.getByRole("button", { name: "Remove API key 1" })).toBeDisabled();
    for (let i = 1; i < 20; i++) await userEvent.click(screen.getByRole("button", { name: "Add API key" }));
    expect(screen.getByRole("button", { name: "Add API key" })).toBeDisabled();
    expect(screen.getAllByLabelText(/^API key \d+$/)).toHaveLength(20);
  });

  it("shows a failed save without caching credentials and clears canceled input", async () => {
    rejectSave = true;
    await openProviders();
    await userEvent.click(screen.getByRole("button", { name: "Add NVIDIA NIM" }));
    await userEvent.type(screen.getByLabelText("API key 1"), "failed-secret");
    await userEvent.click(screen.getByRole("button", { name: "Save provider" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to save credentials");
    expect(JSON.stringify(getProviders())).not.toContain("failed-secret");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Add NVIDIA NIM" }));
    expect(screen.getByLabelText("API key 1")).toHaveValue("");
  });
});
