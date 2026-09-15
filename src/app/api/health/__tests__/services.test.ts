import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET } from "../route";
import {
  saveRegistry,
  setProviderConfigPathsForTest,
} from "@/lib/ai/provider-config/store";
import type { RegistryDocument } from "@/lib/ai/provider-config/schema";
import {
  getEmbeddingConfigFromRegistry,
  getOnnxEmbeddingStatus,
} from "@/lib/memory/embeddings";
import { getRerankerStatus } from "@/lib/memory/reranker";
import {
  discoverModels,
  type DiscoveredModel,
  type ModelKind,
} from "@/lib/models/store";

vi.mock("@/lib/bootstrap", () => ({
  bootstrapAutonomousCognitiveSystem: vi.fn(),
}));
// The route delegates raw status collection to these modules; mock them so the
// service mapping is exercised deterministically without touching the real
// registry / model files / settings DB.
vi.mock("@/lib/memory/embeddings");
vi.mock("@/lib/memory/reranker");
vi.mock("@/lib/models/store");

/** Discovered models with repo metadata for deterministic name resolution. */
const EMBEDDING_DISCOVERED: DiscoveredModel[] = [
  {
    filename: "m.onnx",
    path: "/models/m.onnx",
    repo: "Xenova/bge-small-en-v1.5",
    sizeBytes: 100_000_000,
    isLegacy: false,
  },
];
const RERANKER_DISCOVERED: DiscoveredModel[] = [
  {
    filename: "r.onnx",
    path: "/reranker/r.onnx",
    repo: "BAAI/bge-reranker-v2-m3",
    sizeBytes: 544_000_000,
    isLegacy: false,
  },
];

function seedDoc(baseUrl: string): RegistryDocument {
  return {
    version: 1,
    providers: [
      {
        id: "server",
        kind: "openai-compatible",
        name: "This server",
        baseUrl,
        models: [
          {
            modelId: "test-model",
            displayName: "Test Model",
            isDefault: true,
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
  };
}

function okGateway() {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), {
      status: 200,
    })
  );
}

describe("Health API service status", () => {
  let dataDir: string;

  beforeEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    dataDir = await mkdtemp(join(tmpdir(), "ygg-health-svc-"));
    setProviderConfigPathsForTest(dataDir);
    await saveRegistry(seedDoc("http://localhost:20128/v1"));

    vi.mocked(discoverModels).mockImplementation((kind: ModelKind) => {
      if (kind === "embedding") return EMBEDDING_DISCOVERED;
      if (kind === "reranker") return RERANKER_DISCOVERED;
      return [];
    });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("reports both services as running when ONNX sessions are loaded", async () => {
    okGateway();
    vi.mocked(getEmbeddingConfigFromRegistry).mockResolvedValue({
      provider: "onnx",
      modelPath: "/models/m.onnx",
      chunkSize: 2000,
      chunkOverlap: 200,
    });
    vi.mocked(getOnnxEmbeddingStatus).mockReturnValue({
      modelPath: "/models/m.onnx",
      loaded: true,
      discoveredModels: [],
      pooling: { status: "already-pooled" },
    });
    vi.mocked(getRerankerStatus).mockReturnValue({
      enabled: true,
      available: true,
      loaded: true,
      modelPath: "/reranker/r.onnx",
      sizeBytes: 544_000_000,
      canonicalPath: "/reranker/r.onnx",
      mode: "active",
      discoveredModels: [],
    });

    const res = await GET();
    const json = (await res.json()) as {
      status: string;
      services: {
        embedding: {
          status: string;
          provider: string;
          model: string | null;
          loaded: boolean;
        };
        reranker: {
          status: string;
          provider: string;
          model: string | null;
          loaded: boolean;
        };
      };
    };

    expect(json.status).toBe("ok");
    // Model names come from the discovered repo (HF leaf), not the filename.
    expect(json.services.embedding).toMatchObject({
      status: "running",
      provider: "onnx",
      model: "bge-small-en-v1.5",
      loaded: true,
    });
    expect(json.services.reranker).toMatchObject({
      status: "running",
      provider: "onnx",
      model: "bge-reranker-v2-m3",
      loaded: true,
    });
  });

  it("reports standby when model files exist but sessions are evicted", async () => {
    okGateway();
    vi.mocked(getEmbeddingConfigFromRegistry).mockResolvedValue({
      provider: "onnx",
      modelPath: "/models/m.onnx",
      chunkSize: 2000,
      chunkOverlap: 200,
    });
    vi.mocked(getOnnxEmbeddingStatus).mockReturnValue({
      modelPath: "/models/m.onnx",
      loaded: false,
      discoveredModels: [],
      pooling: { status: "already-pooled" },
    });
    vi.mocked(getRerankerStatus).mockReturnValue({
      enabled: true,
      available: true,
      loaded: false,
      modelPath: "/reranker/r.onnx",
      sizeBytes: 544_000_000,
      canonicalPath: "/reranker/r.onnx",
      mode: "standby",
      discoveredModels: [],
    });

    const json = (await (await GET()).json()) as {
      services: {
        embedding: { status: string; loaded: boolean; model: string | null };
        reranker: { status: string; loaded: boolean; model: string | null };
      };
    };

    expect(json.services.embedding.status).toBe("standby");
    expect(json.services.embedding.loaded).toBe(false);
    expect(json.services.embedding.model).toBe("bge-small-en-v1.5");
    expect(json.services.reranker.status).toBe("standby");
    expect(json.services.reranker.loaded).toBe(false);
    expect(json.services.reranker.model).toBe("bge-reranker-v2-m3");
  });

  it("reports unload when ONNX models are absent / reranker disabled", async () => {
    okGateway();
    vi.mocked(getEmbeddingConfigFromRegistry).mockResolvedValue({
      provider: "onnx",
      modelPath: undefined,
      chunkSize: 2000,
      chunkOverlap: 200,
    });
    vi.mocked(getOnnxEmbeddingStatus).mockReturnValue({
      modelPath: null,
      loaded: false,
      discoveredModels: [],
      pooling: { status: "unresolved" },
    });
    vi.mocked(getRerankerStatus).mockReturnValue({
      enabled: false,
      available: false,
      loaded: false,
      modelPath: null,
      canonicalPath: "/reranker/r.onnx",
      mode: "disabled",
      discoveredModels: [],
    });

    const json = (await (await GET()).json()) as {
      services: {
        embedding: { status: string; model: string | null };
        reranker: { status: string; provider: string };
      };
    };

    expect(json.services.embedding.status).toBe("unload");
    expect(json.services.embedding.model).toBeNull();
    expect(json.services.reranker.status).toBe("unload");
    expect(json.services.reranker.provider).toBe("disabled");
  });

  it("reports a remote embedding provider as running with its model name", async () => {
    okGateway();
    vi.mocked(getEmbeddingConfigFromRegistry).mockResolvedValue({
      provider: "openai-compatible",
      baseUrl: "https://embeddings.example/v1",
      model: "text-embedding-3-small",
      chunkSize: 2000,
      chunkOverlap: 200,
    });
    vi.mocked(getRerankerStatus).mockReturnValue({
      enabled: false,
      available: false,
      loaded: false,
      modelPath: null,
      canonicalPath: "/reranker/r.onnx",
      mode: "disabled",
      discoveredModels: [],
    });

    const json = (await (await GET()).json()) as {
      services: { embedding: { status: string; provider: string; model: string | null } };
    };

    expect(json.services.embedding).toMatchObject({
      status: "running",
      provider: "openai",
      model: "text-embedding-3-small",
    });
  });

  it("still returns services independently of external network connectivity", async () => {
    vi.mocked(getEmbeddingConfigFromRegistry).mockResolvedValue({
      provider: "onnx",
      modelPath: "/models/m.onnx",
      chunkSize: 2000,
      chunkOverlap: 200,
    });
    vi.mocked(getOnnxEmbeddingStatus).mockReturnValue({
      modelPath: "/models/m.onnx",
      loaded: true,
      discoveredModels: [],
      pooling: { status: "already-pooled" },
    });
    vi.mocked(getRerankerStatus).mockReturnValue({
      enabled: true,
      available: true,
      loaded: false,
      modelPath: "/reranker/r.onnx",
      sizeBytes: 544_000_000,
      canonicalPath: "/reranker/r.onnx",
      mode: "standby",
      discoveredModels: [],
    });

    // Point the registry at an unreachable port. Internal health should not depend on it.
    await saveRegistry(seedDoc("http://localhost:1/v1"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

    const json = (await (await GET()).json()) as {
      status: string;
      services: { embedding: { status: string }; reranker: { status: string } };
    };

    expect(json.status).toBe("ok");
    expect(json.services.embedding.status).toBe("running");
    expect(json.services.reranker.status).toBe("standby");
  });
});
