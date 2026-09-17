import { secureFetch } from "@/lib/security/ssrf";
import type { CustomToolExecution } from "./types";

export interface HttpToolExecutionResult {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: string;
  truncated?: boolean;
}

const MAX_OUTPUT_CODEPOINTS = 50_000;
const MAX_ERROR_CODEPOINTS = 4_096;

// ponytail: Array.from(str) in-memory slice → skipped: streaming transform slice for huge bodies, add when tool responses regularly exceed 10MB memory budget.
function codePointSafeSlice(str: string, limit: number): { text: string; truncated: boolean } {
  const codePoints = Array.from(str);
  if (codePoints.length <= limit) {
    return { text: str, truncated: false };
  }
  return {
    text: codePoints.slice(0, limit).join(""),
    truncated: true,
  };
}

function redactSecrets(message: string, headers?: Record<string, string>): string {
  if (!headers || !message) return message;
  let result = message;
  for (const rawVal of Object.values(headers)) {
    if (typeof rawVal !== "string") continue;
    const val = rawVal.trim();
    if (!val) continue;
    result = result.replaceAll(rawVal, "[REDACTED]");
    if (val !== rawVal) {
      result = result.replaceAll(val, "[REDACTED]");
    }
    if (val.toLowerCase().startsWith("bearer ")) {
      const token = val.slice(7).trim();
      if (token) {
        result = result.replaceAll(token, "[REDACTED]");
      }
    }
  }
  return result;
}

export async function executeHttpCustomTool(
  execution: Extract<CustomToolExecution, { type: "http" }>,
  input: Record<string, unknown>,
  callerSignal?: AbortSignal
): Promise<HttpToolExecutionResult> {
  input = (input && typeof input === "object" && !Array.isArray(input)) ? input : {};

  const fail = (error: string, status?: number): HttpToolExecutionResult => ({
    ok: false,
    ...(status !== undefined ? { status } : {}),
    error: redactSecrets(error, execution.headers),
  });
  // Defensive clamp for timeoutMs: [1000, 30000], default 10000
  let timeoutMs = 10000;
  if (typeof execution.timeoutMs === "number" && !isNaN(execution.timeoutMs)) {
    timeoutMs = Math.min(Math.max(execution.timeoutMs, 1000), 30000);
  }

  const consumedKeys = new Set<string>();
  let interpolatedUrl = execution.url.replace(/\{([^}]+)\}/g, (_, varName) => {
    consumedKeys.add(varName);
    const val = input[varName];
    return encodeURIComponent(val !== undefined && val !== null ? String(val) : "");
  });

  const remainingParams: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!consumedKeys.has(k)) {
      remainingParams[k] = v;
    }
  }

  const headers: Record<string, string> = {
    "User-Agent": "yggdrasil-tool/0.1",
    ...(execution.headers ?? {}),
  };

  let requestBody: string | undefined = undefined;
  const method = execution.method.toUpperCase();

  // ponytail: Query serialization & JSON request body serialization → skipped: multipart/form-data and urlencoded POST bodies, add when custom tools support file uploads or legacy form APIs.
  if (method === "GET" || method === "DELETE") {
    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(remainingParams)) {
      if (v !== undefined && v !== null) {
        searchParams.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
    }
    const queryString = searchParams.toString();
    if (queryString) {
      interpolatedUrl += (interpolatedUrl.includes("?") ? "&" : "?") + queryString;
    }
  } else {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    requestBody = JSON.stringify(remainingParams);
  }

  const innerController = new AbortController();
  const timer = setTimeout(() => innerController.abort("timeout"), timeoutMs);

  let callerAbortListener: (() => void) | undefined = undefined;
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timer);
      return fail("Execution cancelled by user.");
    }
    callerAbortListener = () => innerController.abort("cancelled");
    callerSignal.addEventListener("abort", callerAbortListener, { once: true });
  }

  try {
    const response = await secureFetch(interpolatedUrl, {
      method,
      headers,
      body: requestBody,
      signal: innerController.signal,
      timeoutMs,
      allowLoopback: execution.allowLoopback,
    });

    const contentType = response.headers.get("content-type") ?? "";
    const rawText = await response.text();

    if (!response.ok) {
      const slicedError = codePointSafeSlice(rawText, MAX_ERROR_CODEPOINTS);
      return fail(
        `HTTP ${response.status} ${response.statusText}: ${slicedError.text}`,
        response.status
      );
    }

    if (contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(rawText);
        return { ok: true, status: response.status, data: parsed };
      } catch {
        // Fallback to text if JSON parsing fails
      }
    }

    const { text, truncated } = codePointSafeSlice(rawText, MAX_OUTPUT_CODEPOINTS);
    return {
      ok: true,
      status: response.status,
      data: text,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch (err) {
    if (innerController.signal.aborted) {
      const reason = innerController.signal.reason;
      if (reason === "cancelled" || (callerSignal && callerSignal.aborted)) {
        return fail("Execution cancelled by user.");
      }
      return fail(`Execution timed out after ${timeoutMs}ms.`);
    }
    return fail(
      `Network execution error: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timer);
    if (callerSignal && callerAbortListener) {
      callerSignal.removeEventListener("abort", callerAbortListener);
    }
  }
}
