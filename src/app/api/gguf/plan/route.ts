import { NextResponse } from "next/server";
import path from "node:path";
import os from "node:os";
import { stat } from "node:fs/promises";

import { getAvailableMemoryBytes } from "@/lib/system-memory";
import { modelsDirPath } from "@/lib/llama/detect";
import { planServerFlags } from "@/lib/llama/resource-planner";
import { LlamaResourceError } from "@/lib/llama/types";
import { getProviderById } from "@/lib/ai/provider-config/store";

/** Max length for providerId / modelId query parameters. */
const MAX_ID_LEN = 128;

/** Validate a bare providerId or modelId (non-empty, ≤128 chars, no path separators). */
function validateId(value: string | null): string | null {
  if (value === null) return null;
  if (value.length === 0 || value.length > MAX_ID_LEN) return null;
  if (value.includes("/") || value.includes("\\")) return null;
  if (value.includes("..")) return null;
  return value;
}

/** Validate a modelId: must end with .gguf (case-insensitive), bare filename only. */
function validateModelId(value: string | null): string | null {
  const id = validateId(value);
  if (id === null) return null;
  if (!id.toLowerCase().endsWith(".gguf")) return null;
  if (id !== id.split("/").pop()!.split("\\").pop()!) return null;
  return id;
}

/**
 * GET /api/gguf/plan?providerId=p&modelId=m.gguf
 *
 * Computes the PlannedServer flags for a GGUF model on this device. This is
 * server-side only because it needs filesystem access (model file stat) and
 * Node.js built-ins (os.totalmem, /proc/meminfo) that the browser cannot use.
 *
 * Response (200): { planned: PlannedServer, error?: string }
 *   - On success, `planned` contains the full flag set the runner will use.
 *   - On resource error (model too large, not enough memory), returns 200 with
 *     `planned: null` and an `error` string (user-facing).
 *   - On missing model file, returns 404 with an `error` string.
 *   - On missing provider, returns 404 with an `error` string.
 *
 * Any other unexpected throw → 500 with a fixed, non-revealing message.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const providerId = validateId(searchParams.get("providerId"));
  const modelId = validateModelId(searchParams.get("modelId"));
  const filename = validateId(searchParams.get("filename")) ?? modelId;

  if (providerId === null) {
    return NextResponse.json(
      { error: "providerId query parameter is required." },
      { status: 400 },
    );
  }

  if (!modelId && !filename) {
    return NextResponse.json(
      { error: "modelId or filename query parameter is required." },
      { status: 400 },
    );
  }

  // Load the provider to get gguf overrides.
  let overrides: Record<string, unknown> | undefined;
  try {
    const entry = await getProviderById(providerId);
    if (!entry) {
      return NextResponse.json(
        { error: `Provider "${providerId}" not found in registry.` },
        { status: 404 },
      );
    }
    overrides = entry.gguf;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Stat the model file to get its size.
  const modelsDir = modelsDirPath();
  const modelPath = path.join(modelsDir, modelId ?? filename!);
  let modelSizeBytes: number;
  try {
    const statInfo = await stat(modelPath);
    if (!statInfo.isFile()) {
      return NextResponse.json(
        { error: `Model file not found at ${modelPath}.` },
        { status: 404 },
      );
    }
    modelSizeBytes = statInfo.size;
  } catch {
    return NextResponse.json(
      { error: `Model file not found at ${modelPath}.` },
      { status: 404 },
    );
  }

  // Build the device profile.
  const cpuCores = os.cpus().length;
  const totalMemBytes = os.totalmem();
  let freeMemBytes: number;
  try {
    freeMemBytes = getAvailableMemoryBytes();
  } catch {
    freeMemBytes = os.freemem();
  }

  // We don't have modelCtxCap here without the registry entry's model list;
  // pass null and let planServerFlags use the default. The runner will
  // refine this at spawn time using the provider entry.
  const modelCtxCap: number | null = null;

  try {
    const planned = planServerFlags({
      filename: modelId ?? filename!,
      modelSizeBytes,
      modelCtxCap,
      profile: { cpuCores, totalMemBytes, freeMemBytes },
      overrides: overrides as Parameters<typeof planServerFlags>[0]["overrides"],
    });
    return NextResponse.json({ planned });
  } catch (err) {
    if (err instanceof LlamaResourceError) {
      // Resource errors are user-facing (model too large, insufficient memory).
      return NextResponse.json({ planned: null, error: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
