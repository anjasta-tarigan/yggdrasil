import { NextResponse } from "next/server";

import { type RunnerStatus, LlamaResourceError } from "@/lib/llama/types";
import {
  getGgufServerStatus,
  stopGgufServer,
  ensureGgufServerRunning,
} from "@/lib/llama/runner";
import { getProviderById } from "@/lib/ai/provider-config/store";

/** Max length for providerId / modelId request parameters. */
const MAX_ID_LEN = 128;

/** Extract a required query param as a string, or null if absent/empty. */
function queryParam(search: URLSearchParams, name: string): string | null {
  const val = search.get(name);
  if (val === null || val.trim() === "") return null;
  return val;
}

/** Validate a bare providerId or modelId (non-empty, ≤128 chars, no path separators). */
function validateId(value: string | null): string | null {
  if (value === null) return null;
  if (value.length === 0 || value.length > MAX_ID_LEN) return null;
  // Reject embedded path separators or traversal — modelId is a bare filename.
  if (value.includes("/") || value.includes("\\")) return null;
  if (value.includes("..")) return null;
  return value;
}

/** Validate a modelId: must end with .gguf (case-insensitive), no traversal. */
function validateModelId(value: string | null): string | null {
  const id = validateId(value);
  if (id === null) return null;
  if (!id.toLowerCase().endsWith(".gguf")) return null;
  if (id !== id.replace(/^.*\//, "")) return null; // must be a bare filename, not a path
  return id;
}

/**
 * GET /api/gguf/server?providerId=p&modelId=m.gguf
 *
 * Returns the raw RunnerStatus for the given provider+model pair.
 * Task 10 will extend this with a mapped `health` field (additive).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const providerId = queryParam(searchParams, "providerId");
  const modelId = validateModelId(queryParam(searchParams, "modelId"));

  if (providerId === null) {
    return NextResponse.json({ error: "providerId query parameter is required." }, { status: 400 });
  }
  if (modelId === null) {
    return NextResponse.json({ error: "modelId query parameter is required and must be a .gguf filename." }, { status: 400 });
  }

  const status: RunnerStatus = getGgufServerStatus(providerId, modelId);
  return NextResponse.json(status);
}

/**
 * POST /api/gguf/server
 * Body: { action: "start" | "stop", providerId, modelId }
 *
 * - "stop"  → stops the runner, returns { ok: true }
 * - "start" → loads the provider entry, ensures the server is running,
 *             returns { ok: true, baseUrl }
 *
 * On failure, "start" returns { ok: false, error } with:
 *   - 400 for LlamaResourceError (user-facing resource/planning error)
 *   - 500 for any other error (message only, no stack trace)
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json().catch(() => null);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ ok: false, error: "Request body must be a JSON object." }, { status: 400 });
  }

  const { action, providerId, modelId } = body as Record<string, unknown>;

  // Validate action.
  if (action !== "start" && action !== "stop") {
    return NextResponse.json({ ok: false, error: `Unknown action "${String(action ?? "")}".` }, { status: 400 });
  }

  // Validate providerId: non-empty string ≤128 chars, no path separators.
  if (typeof providerId !== "string" || providerId.length === 0 || providerId.length > MAX_ID_LEN) {
    return NextResponse.json({ ok: false, error: "providerId must be a non-empty string of at most 128 characters." }, { status: 400 });
  }
  if (providerId.includes("/") || providerId.includes("\\") || providerId.includes("..")) {
    return NextResponse.json({ ok: false, error: "providerId must not contain path separators or traversal sequences." }, { status: 400 });
  }

  // Validate modelId: non-empty string ≤128, must end .gguf, bare filename only.
  if (typeof modelId !== "string" || modelId.length === 0 || modelId.length > MAX_ID_LEN) {
    return NextResponse.json({ ok: false, error: "modelId must be a non-empty string of at most 128 characters." }, { status: 400 });
  }
  if (modelId.includes("..") || modelId !== modelId.split("/").pop()!.split("\\").pop()!) {
    return NextResponse.json({ ok: false, error: "modelId must be a bare filename (no path separators)." }, { status: 400 });
  }
  if (!modelId.toLowerCase().endsWith(".gguf")) {
    return NextResponse.json({ ok: false, error: "modelId must end with .gguf." }, { status: 400 });
  }

  if (action === "stop") {
    await stopGgufServer(providerId, modelId);
    return NextResponse.json({ ok: true });
  }

  // action === "start"
  try {
    const entry = await getProviderById(providerId);
    if (!entry) {
      return NextResponse.json(
        { ok: false, error: `Provider "${providerId}" not found in registry.` },
        { status: 404 },
      );
    }
    const baseUrl = await ensureGgufServerRunning(entry, modelId);
    return NextResponse.json({ ok: true, baseUrl });
  } catch (err) {
    if (err instanceof LlamaResourceError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
