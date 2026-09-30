import { NextResponse } from "next/server";

import { findLlamaServer } from "@/lib/llama/detect";
import { LlamaResourceError, MIN_LLAMA_SERVER_BUILD } from "@/lib/llama/types";

/**
 * GET /api/gguf/status
 *
 * Probes the system for the llama-server binary and its version.
 *
 * Response shape:
 *  - found: boolean — binary discovered (configured path or PATH scan)
 *  - path: string | null — absolute path to the binary
 *  - version: number | null — parsed build number (null when --version output is unrecognised)
 *  - meetsMinimum: boolean — true when version >= MIN_LLAMA_SERVER_BUILD
 *
 * A below-minimum version: `findLlamaServer` throws LlamaResourceError,
 * which we surface as 200 with meetsMinimum:false and an actionable `error`.
 * Any other unexpected throw → 500 with a fixed, non-revealing message
 * (per ollama/route.ts conventions: never leak stack traces to the client).
 */
export async function GET(): Promise<NextResponse> {
  let info: { path: string; version: number | null } | null;
  try {
    info = await findLlamaServer();
  } catch (err) {
    if (err instanceof LlamaResourceError) {
      // Below-minimum version — the message is user-facing guidance.
      // findLlamaServer throws only when it found the binary but the version
      // was below the minimum, so we know path/version are known-bad but
      // the throw happens before they're returned. Surface what we can.
      return NextResponse.json({
        found: true,
        path: null,
        version: null,
        meetsMinimum: false,
        error: err.message,
      });
    }
    // Unexpected: never leak details to the client.
    return NextResponse.json(
      { error: "Could not probe llama-server" },
      { status: 500 },
    );
  }

  if (!info) {
    return NextResponse.json({
      found: false,
      path: null,
      version: null,
      meetsMinimum: false,
    });
  }

  const meetsMinimum = info.version !== null && info.version >= MIN_LLAMA_SERVER_BUILD;

  if (!meetsMinimum) {
    return NextResponse.json({
      found: true,
      path: info.path,
      version: info.version,
      meetsMinimum: false,
      error:
        info.version === null
          ? `llama-server version could not be parsed; minimum build ${MIN_LLAMA_SERVER_BUILD} is required.`
          : `llama-server build ${info.version} is below the minimum of ${MIN_LLAMA_SERVER_BUILD}.`,
    });
  }

  return NextResponse.json({
    found: true,
    path: info.path,
    version: info.version,
    meetsMinimum: true,
  });
}
