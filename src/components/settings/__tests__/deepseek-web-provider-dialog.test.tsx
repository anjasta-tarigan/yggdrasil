import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeepSeekWebProviderDialog } from "../deepseek-web-provider-dialog";
import { ExperimentalWebProvidersSection } from "../experimental-web-providers-section";
import * as settings from "@/lib/settings";

vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings")>();
  return {
    ...actual,
    checkWebProviderSession: vi.fn(),
    saveWebProviderSession: vi.fn(),
    discoverWebProviderModels: vi.fn(),
    deleteWebProviderSession: vi.fn(),
  };
});

const checkMock = vi.mocked(settings.checkWebProviderSession);
const saveMock = vi.mocked(settings.saveWebProviderSession);
const discoverMock = vi.mocked(settings.discoverWebProviderModels);

const CAPTURED_USER_AGENT = "TestAgent/1.0 (jsdom)";
const REJECTED_COPY =
  "The session was rejected. Your credentials were not saved.";

function renderDialog(overrides?: {
  onClose?: () => void;
  onSaved?: (outcome: {
    discoveredModels: number | null;
    discoveryFailed: boolean;
    source: "save" | "refresh";
  }) => void;
}) {
  const onClose = overrides?.onClose ?? vi.fn();
  const onSaved = overrides?.onSaved ?? vi.fn();
  render(
    <DeepSeekWebProviderDialog
      open
      onClose={onClose}
      onSaved={onSaved}
    />
  );
  return { onClose, onSaved };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The browser mode must read this value, never a server-side one.
  Object.defineProperty(window.navigator, "userAgent", {
    value: CAPTURED_USER_AGENT,
    configurable: true,
  });
  checkMock.mockResolvedValue({ ok: true });
  saveMock.mockResolvedValue({
    ok: true,
    lastCheckedAt: new Date().toISOString(),
  });
  discoverMock.mockResolvedValue({ ok: true, models: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DeepSeekWebProviderDialog — experimental banner (Spec §10.2)", () => {
  it("renders the spec's exact persistent copy and expands the limitations text", () => {
    renderDialog();

    expect(
      screen.getByText(
        "Experimental: DeepSeek Web uses the web interface, not the official API."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /It may stop working when DeepSeek changes its web client\. Use an account you control\. Credentials and request identity are sent to the configured Yggdrasil server\./
      )
    ).toBeInTheDocument();

    // The expansion is optional; the experimental label is not.
    expect(
      screen.queryByText(/This integration is unofficial and may be affected/)
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /View limitations/i }));

    expect(
      screen.getByText(
        /This integration is unofficial and may be affected by session expiry, device binding, rate limits, security checks, or provider changes\./
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Yggdrasil does not collect browser credentials automatically, upload browser profiles, or bypass provider security controls\. Session credentials cannot be refreshed automatically\./
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Experimental: DeepSeek Web uses the web interface, not the official API."
      )
    ).toBeInTheDocument();
  });
});

describe("DeepSeekWebProviderDialog — check and save are separate (Spec §5.3)", () => {
  it("keeps Save provider disabled until a check succeeds", async () => {
    const user = userEvent.setup();
    renderDialog();

    const saveButton = screen.getByRole("button", { name: "Save provider" });
    const checkButton = screen.getByRole("button", { name: "Check connection" });
    expect(saveButton).toBeDisabled();
    // Nothing to check yet, so the side-effect-free action is gated too.
    expect(checkButton).toBeDisabled();

    await user.type(screen.getByLabelText("Web session token"), "sk-draft");
    expect(checkButton).toBeEnabled();
    expect(saveButton).toBeDisabled();

    await user.click(checkButton);
    await waitFor(() => expect(saveButton).toBeEnabled());
    expect(checkMock).toHaveBeenCalledTimes(1);
    expect(saveMock).not.toHaveBeenCalled();

    // Editing the draft invalidates the verification: Save re-arms the gate.
    await user.type(screen.getByLabelText("Web session token"), "x");
    expect(saveButton).toBeDisabled();
  });

  it("shows the rejection copy on a failed check and preserves the draft", async () => {
    const user = userEvent.setup();
    checkMock.mockResolvedValue({ ok: false });
    renderDialog();

    const token = screen.getByLabelText("Web session token");
    await user.type(token, "sk-rejected");
    await user.click(screen.getByRole("button", { name: "Check connection" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(REJECTED_COPY);
    expect(token).toHaveValue("sk-rejected");
    expect(screen.getByRole("button", { name: "Save provider" })).toBeDisabled();
  });

  it("shows the server's sanitized message when the check reports one", async () => {
    const user = userEvent.setup();
    checkMock.mockResolvedValue({
      ok: false,
      code: "rate_limited",
      message: "Too many attempts. Try again after the cooldown.",
    });
    renderDialog();

    await user.type(screen.getByLabelText("Web session token"), "sk-limited");
    await user.click(screen.getByRole("button", { name: "Check connection" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts. Try again after the cooldown."
    );
  });

  it("clears the secret after a successful save and discovers models exactly once", async () => {
    const user = userEvent.setup();
    discoverMock.mockResolvedValue({
      ok: true,
      models: [
        { modelId: "deepseek-chat", displayName: "DeepSeek Chat" },
      ] as never,
    });
    const { onSaved, onClose } = renderDialog();

    const token = screen.getByLabelText("Web session token");
    await user.type(token, "sk-save");
    await user.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save provider" })).toBeEnabled()
    );
    await user.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenCalledWith({
      providerId: "deepseek-web",
      userToken: "sk-save",
      userAgentMode: "browser",
      userAgent: CAPTURED_USER_AGENT,
    });
    // Spec §5.3: the secret is cleared from component state, not kept in a draft.
    expect(token).toHaveValue("");
    // Spec §8.1: exactly one discovery request after a successful save.
    expect(discoverMock).toHaveBeenCalledTimes(1);
    expect(discoverMock).toHaveBeenCalledWith("deepseek-web", true);
    // Spec §5.3: the success copy is displayed before the dialog is dismissed.
    expect(await screen.findByText("Connection verified.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith({
      discoveredModels: 1,
      discoveryFailed: false,
      source: "save",
    });

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft open and reports a failed save without discovering", async () => {
    const user = userEvent.setup();
    saveMock.mockResolvedValue({
      ok: false,
      code: "session_rejected",
      message: REJECTED_COPY,
    });
    const { onSaved } = renderDialog();

    const token = screen.getByLabelText("Web session token");
    await user.type(token, "sk-draft");
    await user.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save provider" })).toBeEnabled()
    );
    await user.click(screen.getByRole("button", { name: "Save provider" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(REJECTED_COPY);
    expect(token).toHaveValue("sk-draft");
    expect(discoverMock).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("DeepSeekWebProviderDialog — discovery actions (Spec §8.1)", () => {
  it("offers Discover models, then Refresh models with the last-discovered label", async () => {
    const user = userEvent.setup();
    discoverMock.mockResolvedValue({
      ok: true,
      models: [
        { modelId: "a", displayName: "A" },
        { modelId: "b", displayName: "B" },
      ] as never,
    });
    renderDialog();

    const discoverButton = screen.getByRole("button", {
      name: "Discover models",
    });
    await user.click(discoverButton);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh models" })
      ).toBeInTheDocument()
    );
    expect(discoverMock).toHaveBeenCalledWith("deepseek-web", true);
    expect(screen.getByText("2 models discovered")).toBeInTheDocument();
    expect(screen.getByText(/Last discovered just now/)).toBeInTheDocument();
    expect(screen.queryByText("Last known list")).not.toBeInTheDocument();
  });

  it("keeps the last known list and labels it stale when refresh fails", async () => {
    const user = userEvent.setup();
    discoverMock.mockResolvedValueOnce({
      ok: true,
      models: [{ modelId: "a", displayName: "A" }] as never,
    });
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Discover models" }));
    await waitFor(() =>
      expect(screen.getByText("1 model discovered")).toBeInTheDocument()
    );

    discoverMock.mockResolvedValueOnce({ ok: false, code: "timeout" });
    await user.click(screen.getByRole("button", { name: "Refresh models" }));

    expect(await screen.findByText("Last known list")).toBeInTheDocument();
    // The stale label accompanies the preserved count, it does not replace it.
    expect(screen.getByText("1 model discovered")).toBeInTheDocument();
    // A refresh saved nothing, so the copy must not claim the session was saved.
    expect(
      await screen.findByText(
        "Model discovery failed. The last known model list was kept."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/The session was saved/)
    ).not.toBeInTheDocument();
  });

  it("reports a save whose post-save discovery failed as a saved session", async () => {
    const user = userEvent.setup();
    discoverMock.mockResolvedValue({ ok: false, code: "timeout" });
    const { onSaved } = renderDialog();

    await user.type(screen.getByLabelText("Web session token"), "sk-saved");
    await user.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save provider" })).toBeEnabled()
    );
    await user.click(screen.getByRole("button", { name: "Save provider" }));

    // The session was committed; only discovery failed. The copy says so.
    expect(
      await screen.findByText(
        "The session was saved, but model discovery failed."
      )
    ).toBeInTheDocument();
    // A first failure has no last-known list to claim was kept.
    expect(screen.queryByText(/last known model list was kept/)).not.toBeInTheDocument();
    expect(onSaved).toHaveBeenCalledWith({
      discoveredModels: null,
      discoveryFailed: true,
      source: "save",
    });
  });

  it("reports a first discovery failure instead of silently doing nothing", async () => {
    const user = userEvent.setup();
    discoverMock.mockResolvedValue({ ok: false, code: "timeout" });
    renderDialog();

    await user.click(screen.getByRole("button", { name: "Discover models" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Model discovery failed. Try again later."
    );
    // No last-known list exists, so the stale label must not appear.
    expect(screen.queryByText("Last known list")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discover models" })).toBeInTheDocument();
  });
});

describe("DeepSeekWebProviderDialog — interactive targets (Spec §10.3)", () => {
  it("gives each request-identity row a 44px minimum height", () => {
    renderDialog();

    for (const mode of ["browser", "server-default", "custom"]) {
      expect(screen.getByTestId(`ua-mode-row-${mode}`)).toHaveClass("min-h-11");
    }
  });

  it("gives the small buttons a 44px hit area without enlarging their icons", () => {
    renderDialog();

    // "How to get this?" opens the help panel, whose close button is also small.
    const helpButton = screen.getByRole("button", {
      name: /How to get this\?/i,
    });
    expect(helpButton).toHaveClass("h-11");

    fireEvent.click(helpButton);
    expect(screen.getByRole("button", { name: "Close help panel" })).toHaveClass(
      "min-h-11",
      "min-w-11"
    );
  });
});

describe("DeepSeekWebProviderDialog — contextual help (Spec §10.3)", () => {
  it("opens the help panel without resetting the form", async () => {
    const user = userEvent.setup();
    renderDialog();

    const token = screen.getByLabelText("Web session token");
    await user.type(token, "sk-keep");

    await user.click(screen.getByRole("button", { name: /How to get this\?/i }));

    expect(
      screen.getByText(/How to get your session token/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Do not share it in screenshots, issue reports, chat messages, or logs\./
      )
    ).toBeInTheDocument();
    // Opening help must not touch the draft.
    expect(token).toHaveValue("sk-keep");

    await user.click(
      screen.getByRole("button", { name: /Close help panel/i })
    );
    expect(
      screen.queryByText(/How to get your session token/i)
    ).not.toBeInTheDocument();
    expect(token).toHaveValue("sk-keep");
  });
});

describe("DeepSeekWebProviderDialog — request identity (Spec §5.2)", () => {
  it("renders all three modes and shows the captured User-Agent read-only in browser mode", async () => {
    renderDialog();

    expect(
      screen.getByLabelText("Use this browser's User-Agent")
    ).toBeChecked();
    expect(
      screen.getByLabelText("Use Yggdrasil's default User-Agent")
    ).not.toBeChecked();
    expect(
      screen.getByLabelText("Use a custom User-Agent (Advanced)")
    ).not.toBeChecked();

    const captured = await screen.findByLabelText(
      "Captured browser User-Agent"
    );
    expect(captured).toHaveAttribute("readonly");
    expect(captured).toHaveValue(CAPTURED_USER_AGENT);
  });

  it("sends the browser User-Agent on Check and only on Check", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Web session token"), "sk-browser");
    await user.click(screen.getByRole("button", { name: "Check connection" }));

    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));
    expect(checkMock).toHaveBeenCalledWith({
      providerId: "deepseek-web",
      userToken: "sk-browser",
      userAgentMode: "browser",
      userAgent: CAPTURED_USER_AGENT,
    });
  });

  it("omits the User-Agent for the server default and sends the custom value for custom", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(
      screen.getByLabelText("Use Yggdrasil's default User-Agent")
    );
    await user.type(screen.getByLabelText("Web session token"), "sk-default");
    await user.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(1));
    expect(checkMock).toHaveBeenLastCalledWith({
      providerId: "deepseek-web",
      userToken: "sk-default",
      userAgentMode: "server-default",
    });

    await user.click(
      screen.getByLabelText("Use a custom User-Agent (Advanced)")
    );
    await user.type(
      screen.getByLabelText("Custom User-Agent"),
      "CustomAgent/9"
    );
    await user.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(checkMock).toHaveBeenCalledTimes(2));
    expect(checkMock).toHaveBeenLastCalledWith({
      providerId: "deepseek-web",
      userToken: "sk-default",
      userAgentMode: "custom",
      userAgent: "CustomAgent/9",
    });
  });
});

describe("DeepSeekWebProviderDialog — credential containment (Spec §4.3)", () => {
  it("never writes the token to localStorage or sessionStorage", async () => {
    const user = userEvent.setup();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem");
    renderDialog();

    const token = screen.getByLabelText("Web session token");
    await user.type(token, "sk-never-stored");
    await user.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save provider" })).toBeEnabled()
    );
    await user.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));

    expect(setItemSpy).not.toHaveBeenCalled();
    expect(getItemSpy).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe("ExperimentalWebProvidersSection — provider entry (Spec §10.1)", () => {
  function catalogResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("lists DeepSeek Web apart from API providers and opens the dialog from Configure", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      catalogResponse({
        providers: [
          {
            id: "deepseek-web",
            name: "DeepSeek Web",
            experimental: true,
            enabled: true,
            models: [],
            session: { status: "not-configured", lastCheckedAt: null },
          },
        ],
      })
    );

    render(<ExperimentalWebProvidersSection registryProviders={[]} />);

    expect(
      await screen.findByText("Experimental Web Providers")
    ).toBeInTheDocument();
    expect(screen.getByText("DeepSeek Web")).toBeInTheDocument();
    expect(screen.getByText("Experimental Web Provider")).toBeInTheDocument();
    expect(screen.getByText("Session: Not configured")).toBeInTheDocument();
    expect(screen.getByText("Models: 0")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Configure DeepSeek Web" })
    );
    expect(
      await screen.findByRole("dialog")
    ).toBeInTheDocument();
  });

  it("reports a verified session and the discovered model count from the registry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      catalogResponse({
        providers: [
          {
            id: "deepseek-web",
            name: "DeepSeek Web",
            experimental: true,
            enabled: true,
            models: [],
            session: {
              status: "verified",
              lastCheckedAt: new Date().toISOString(),
            },
          },
        ],
      })
    );

    render(
      <ExperimentalWebProvidersSection
        registryProviders={
          [
            {
              id: "deepseek-web",
              name: "DeepSeek Web",
              kind: "web-session",
              baseUrl: "https://chat.deepseek.com",
              apiKeyConfigured: false,
              models: [
                { modelId: "a", displayName: "A" },
                { modelId: "b", displayName: "B" },
                { modelId: "c", displayName: "C" },
                { modelId: "d", displayName: "D" },
              ],
            },
          ] as never
        }
      />
    );

    expect(await screen.findByText("Session: Verified")).toBeInTheDocument();
    expect(screen.getByText("Models: 4")).toBeInTheDocument();
    expect(screen.getByText(/Last checked just now/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage session DeepSeek Web" })
    ).toBeInTheDocument();
  });

  it("keeps manual model entry available (Spec §15.14)", async () => {
    const user = userEvent.setup();
    const addModel = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      catalogResponse({
        providers: [
          {
            id: "deepseek-web",
            name: "DeepSeek Web",
            experimental: true,
            enabled: true,
            models: [],
            session: { status: "verified", lastCheckedAt: new Date().toISOString() },
          },
        ],
      })
    );

    render(
      <ExperimentalWebProvidersSection
        addModel={addModel}
        registryProviders={[]}
      />
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Add model manually to DeepSeek Web",
      })
    );
    expect(addModel).toHaveBeenCalledWith("deepseek-web");
  });

  it("offers no session action when the feature-disabled route answers 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      catalogResponse({ ok: false, code: "feature_disabled" }, 404)
    );

    const { container } = render(
      <ExperimentalWebProvidersSection registryProviders={[]} />
    );

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
