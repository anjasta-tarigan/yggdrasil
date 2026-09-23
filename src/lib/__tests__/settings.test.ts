import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addProvider,
  chatRequestBody,
  decodeModelRef,
  encodeModelRef,
  getProviders,
  getEmbeddingSettings,
  hydrateSettings,
  saveProviders,
  SERVER_PROVIDER_ID,
  PROVIDERS_CHANGED_EVENT,
  type ProviderConfig,
} from "@/lib/settings";

describe("settings client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("chatRequestBody", () => {
    it("returns model and chatId with qualified model ref without provider key", () => {
      const res = chatRequestBody("server::m1", "chat-123");
      expect(res).toEqual({
        model: "server::m1",
        chatId: "chat-123",
      });
      expect(res).not.toHaveProperty("provider");
    });

    it("returns undefined when both ref and chatId are empty/null", () => {
      expect(chatRequestBody(null)).toBeUndefined();
      expect(chatRequestBody(null, undefined)).toBeUndefined();
    });

    it("returns only chatId if ref is null", () => {
      expect(chatRequestBody(null, "chat-123")).toEqual({ chatId: "chat-123" });
    });

    it("returns only model if chatId is undefined", () => {
      expect(chatRequestBody("server::m1")).toEqual({ model: "server::m1" });
    });
  });

  describe("encodeModelRef and decodeModelRef", () => {
    it("encodes providerId and modelId", () => {
      expect(encodeModelRef("server", "gpt-4o")).toBe("server::gpt-4o");
      expect(encodeModelRef("custom-prov", "llama3")).toBe("custom-prov::llama3");
    });

    it("decodes qualified model refs", () => {
      expect(decodeModelRef("server::gpt-4o")).toEqual({
        providerId: "server",
        modelId: "gpt-4o",
      });
      expect(decodeModelRef("custom::llama3:8b")).toEqual({
        providerId: "custom",
        modelId: "llama3:8b",
      });
    });

    it("handles legacy unqualified model ref and null", () => {
      expect(decodeModelRef("gpt-4o")).toEqual({
        providerId: SERVER_PROVIDER_ID,
        modelId: "gpt-4o",
      });
      expect(decodeModelRef(null)).toEqual({
        providerId: SERVER_PROVIDER_ID,
        modelId: null,
      });
    });
  });

  describe("hydrateSettings", () => {
    it("fetches both /api/providers and /api/settings concurrently and stores redacted providers", async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url === "/api/providers") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              providers: [
                {
                  id: "server",
                  name: "Server",
                  kind: "openai-compatible",
                  baseUrl: "http://localhost:11434/v1",
                  apiKeyConfigured: true,
                  models: [
                    {
                      modelId: "gpt-4o",
                      displayName: "GPT-4o",
                      isDefault: true,
                      capabilities: {
                        contextWindow: 128000,
                        maxOutputTokens: 4096,
                        inputModalities: ["text"],
                        outputModalities: ["text"],
                        supportsToolCalls: true,
                        supportsReasoning: false,
                      },
                      capabilitySources: {},
                    },
                  ],
                },
              ],
              embedding: {
                providerId: "server",
                model: "text-embedding-3-small",
                dimensions: 1536,
                chunkSize: 2000,
                chunkOverlap: 200,
              },
            }),
          });
        }
        if (url === "/api/settings") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              store: {
                websearch: {
                  providers: [
                    { kind: "searxng", enabled: true, baseUrl: "http://searxng:8080" },
                  ],
                },
                mcpServers: [
                  {
                    id: "srv1",
                    name: "FS",
                    transport: "stdio",
                    command: "node",
                    args: ["server.js"],
                    enabled: true,
                  },
                ],
              },
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }) as unknown as typeof globalThis.fetch;

      await hydrateSettings();

      const providers = getProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].id).toBe("server");
      expect(providers[0].apiKeyConfigured).toBe(true);
      expect(providers[0].models[0].modelId).toBe("gpt-4o");
      expect(providers[0]).not.toHaveProperty("apiKey");

      const embedding = getEmbeddingSettings();
      expect(embedding.model).toBe("text-embedding-3-small");
      expect(embedding.dimensions).toBe(1536);
    });

    it("never stores apiKey plaintext in getProviders() even if returned in API response", async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url === "/api/providers") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              providers: [
                {
                  id: "p-leak",
                  name: "Leaky Provider",
                  kind: "openai-compatible",
                  baseUrl: "https://api.example.com/v1",
                  apiKey: "sk-secret-leak-12345",
                  apiKeyConfigured: true,
                  models: [],
                },
              ],
              embedding: null,
            }),
          });
        }
        if (url === "/api/settings") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ store: {} }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }) as unknown as typeof globalThis.fetch;

      await hydrateSettings();

      const providers = getProviders();
      // Leaked apiKey must be stripped or rejected
      const leaky = providers.find((p) => p.id === "p-leak");
      if (leaky) {
        expect("apiKey" in (leaky as object)).toBe(false);
      }
    });

    it("keeps a web-session provider entry instead of dropping it during hydration", async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url === "/api/providers") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              providers: [
                {
                  id: "deepseek-web",
                  name: "DeepSeek Web",
                  kind: "web-session",
                  baseUrl: "https://chat.deepseek.com",
                  apiKeyConfigured: false,
                  models: [
                    {
                      modelId: "deepseek-chat",
                      displayName: "DeepSeek Chat",
                      isDefault: false,
                      capabilities: {
                        contextWindow: null,
                        maxOutputTokens: null,
                        inputModalities: ["text"],
                        outputModalities: ["text"],
                        supportsToolCalls: null,
                        supportsReasoning: null,
                      },
                      capabilitySources: {},
                    },
                  ],
                },
              ],
              embedding: null,
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({ store: {} }) });
      }) as unknown as typeof globalThis.fetch;

      await hydrateSettings();

      const providers = getProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0].kind).toBe("web-session");
      expect(providers[0].models[0].modelId).toBe("deepseek-chat");
    });

    it("handles hydration failure gracefully without throwing", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network Error"));
      await expect(hydrateSettings()).resolves.toBeUndefined();
    });
  });

  describe("credential writes", () => {
    const provider: ProviderConfig = {
      id: "credentials", name: "Credentials", kind: "openai-compatible",
      baseUrl: "https://api.example.com/v1", apiKeyConfigured: false, models: [],
    };

    it("sends a replacement single key and caches only the returned server view", async () => {
      const returned = { ...provider, apiKeyEnv: "PROVIDER_CREDENTIALS_API_KEY", apiKeyConfigured: true };
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ providers: [returned] }) });
      await saveProviders([{ ...provider, apiKey: "single-secret" }]);
      const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
      expect(body.providers[0].apiKey).toBe("single-secret");
      expect(getProviders()).toEqual([returned]);
      expect(JSON.stringify(getProviders())).not.toContain("single-secret");
    });

    it("preserves credentials passed to addProvider", async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ providers: [] }) });
      await addProvider({ ...provider, apiKey: "new-secret" });
      const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
      expect(body.providers.at(-1).apiKey).toBe("new-secret");
    });

    it("sends NIM row intents without caching values while saving or after a leaky response", async () => {
      const view = { ...provider, preset: "nvidia-nim", apiKeys: [
        { id: "keep", apiKeyEnv: "PROVIDER_CREDENTIALS_KEEP_API_KEY", configured: true },
        { id: "replace", apiKeyEnv: "PROVIDER_CREDENTIALS_REPLACE_API_KEY", configured: true },
      ] };
      let finish!: (value: Response) => void;
      global.fetch = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
      const saving = saveProviders([{ ...provider, preset: "nvidia-nim", apiKeys: [
        { id: "keep" }, { id: "replace", value: "row-secret" },
      ] }]);
      expect(JSON.stringify(getProviders())).not.toContain("row-secret");
      const body = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
      expect(body.providers[0].apiKeys).toEqual([{ id: "keep" }, { id: "replace", value: "row-secret" }]);
      finish(new Response(JSON.stringify({ providers: [{ ...view, apiKey: "leak", clearApiKey: true,
        apiKeys: view.apiKeys.map((row) => ({ ...row, value: "row-secret" })),
      }] })));
      await saving;
      // Cache holds only { id, configured }, never apiKeyEnv or values.
      const expected = { ...view, apiKeys: view.apiKeys.map(({ id, configured }) => ({ id, configured })) };
      expect(getProviders()).toEqual([expected]);
    });
  });

  describe("saveProviders", () => {
    it("updates local cache, dispatches event, and PUTs to /api/providers", async () => {
      let dispatched = false;
      const listener = () => {
        dispatched = true;
      };
      window.addEventListener(PROVIDERS_CHANGED_EVENT, listener);

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ providers: updatedProviders }),
      });

      const updatedProviders: ProviderConfig[] = [
        {
          id: "p1",
          name: "Provider 1",
          kind: "ollama",
          baseUrl: "http://localhost:11434",
          apiKeyConfigured: false,
          models: [],
        },
      ];

      await saveProviders(updatedProviders);

      expect(getProviders()).toEqual(updatedProviders);
      expect(dispatched).toBe(true);
      const sent = JSON.parse(vi.mocked(global.fetch).mock.calls[0][1]!.body as string);
      expect(sent).toEqual({
        providers: [
          {
            id: "p1", name: "Provider 1", kind: "ollama",
            baseUrl: "http://localhost:11434", models: [],
          },
        ],
      });

      window.removeEventListener(PROVIDERS_CHANGED_EVENT, listener);
    });
  });
});
