import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/llama/detect", () => ({
  findLlamaServer: vi.fn(async () => ({ path: "/usr/local/bin/llama-server", version: 7231 })),
  scanGgufModels: vi.fn(async () => [
    { filename: "a.gguf", path: "/data/a.gguf", sizeBytes: 100, fitsMemory: true },
  ]),
}));
vi.mock("@/lib/llama/runner", () => ({
  getGgufServerStatus: vi.fn(() => ({ state: "running", pid: 1, planned: null, lastError: null })),
  stopGgufServer: vi.fn(async () => {}),
}));

import { GET as statusGET } from "@/app/api/gguf/status/route";
import { GET as modelsGET } from "@/app/api/gguf/models/route";
import { GET as serverGET, POST as serverPOST } from "@/app/api/gguf/server/route";

describe("gguf routes", () => {
  it("GET /api/gguf/status reports binary + version + minimum gate", async () => {
    const res = await statusGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ found: true, version: 7231, meetsMinimum: true });
  });

  it("GET /api/gguf/models returns the scan list", async () => {
    const res = await modelsGET();
    const body = await res.json();
    expect(body.models).toHaveLength(1);
    expect(body.models[0].filename).toBe("a.gguf");
  });

  it("GET /api/gguf/server requires providerId + modelId", async () => {
    const res = await serverGET(new Request("http://x/api/gguf/server"));
    expect(res.status).toBe(400);
    const ok = await serverGET(new Request("http://x/api/gguf/server?providerId=p&modelId=m.gguf"));
    expect(ok.status).toBe(200);
  });

  it("POST /api/gguf/server rejects unknown actions and traversal modelIds", async () => {
    const bad = await serverPOST(new Request("http://x/api/gguf/server", {
      method: "POST",
      body: JSON.stringify({ action: "explode", providerId: "p", modelId: "m.gguf" }),
    }));
    expect(bad.status).toBe(400);
    const traversal = await serverPOST(new Request("http://x/api/gguf/server", {
      method: "POST",
      body: JSON.stringify({ action: "stop", providerId: "p", modelId: "../x.gguf" }),
    }));
    expect(traversal.status).toBe(400);
  });
});
