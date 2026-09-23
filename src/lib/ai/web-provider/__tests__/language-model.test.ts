// @vitest-environment node
/**
 * The web-session language model is a deliberate stub until Task 9c wires the
 * DeepSeek adapter's SSE frames into AI SDK stream parts. These tests pin the
 * seam's contract: construction is side-effect free, and generation fails with
 * a typed error rather than resolving with an empty stream — the silent-success
 * defect the chat route's 401 gate exists to prevent.
 */
import { describe, it, expect } from "vitest";
import {
  WebProviderGenerationUnavailableError,
  WebProviderLanguageModel,
  createWebProviderModel,
} from "../language-model";
import type { ProviderEntry } from "@/lib/ai/provider-config/schema";
import type { WebProviderSession } from "../types";

const webSessionEntry: ProviderEntry = {
  id: "deepseek-web",
  kind: "web-session",
  name: "DeepSeek Web",
  baseUrl: "https://chat.deepseek.com",
  models: [],
};

const verifiedSession: WebProviderSession = {
  id: "wps-1",
  providerId: "deepseek-web",
  userToken: "sk-session-token",
  status: "verified",
  lastCheckedAt: null,
  lastFailureCode: null,
  userAgentMode: "browser",
  capturedAt: null,
  sessionVersion: 1,
};

describe("WebProviderLanguageModel", () => {
  it("declares the v4 specification and empty supportedUrls", () => {
    const model = createWebProviderModel(webSessionEntry, "deepseek-chat", verifiedSession);

    expect(model.specificationVersion).toBe("v4");
    expect(model.provider).toBe("deepseek-web");
    expect(model.modelId).toBe("deepseek-chat");
    // Empty, not undefined: `isUrlSupported` does an unguarded Object.entries,
    // so a missing map throws as soon as a prompt carries a file part.
    expect(model.supportedUrls).toEqual({});
  });

  it("carries the verified session through to the adapter seam", () => {
    const model = createWebProviderModel(webSessionEntry, "deepseek-chat", verifiedSession);

    expect(model.session).toBe(verifiedSession);
  });

  it("throws a typed error from doStream instead of returning an empty stream", async () => {
    const model = new WebProviderLanguageModel("deepseek-web", "deepseek-chat", verifiedSession);

    await expect(model.doStream()).rejects.toBeInstanceOf(
      WebProviderGenerationUnavailableError
    );
  });

  it("throws a typed error from doGenerate instead of returning empty text", async () => {
    const model = new WebProviderLanguageModel("deepseek-web", "deepseek-chat", null);

    await expect(model.doGenerate()).rejects.toBeInstanceOf(
      WebProviderGenerationUnavailableError
    );
  });
});
