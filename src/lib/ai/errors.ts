/**
 * Error formatting utilities for upstream model/provider errors.
 *
 * Extracts clear, human-readable error messages from diverse error types,
 * including APICallError (with JSON response bodies from providers like OpenRouter/vLLM),
 * nested Error.cause hierarchies, and raw object payloads, preventing opaque
 * `[object Object]` strings from leaking to the client.
 */

/**
 * Extracts a concise, informative error message from an error of unknown shape.
 */
export function formatErrorDetail(error: unknown): string {
  if (error == null) return "Unknown error";

  // 1. Check for responseBody on APICallError or provider response errors
  if (
    typeof error === "object" &&
    error !== null &&
    "responseBody" in error &&
    typeof (error as { responseBody: unknown }).responseBody === "string"
  ) {
    const rawBody = (error as { responseBody: string }).responseBody.trim();
    if (rawBody.length > 0) {
      try {
        const json = JSON.parse(rawBody) as Record<string, unknown>;
        if (json && typeof json === "object") {
          // Standard OpenAI/OpenRouter error structure: { error: { message, code } }
          if (
            typeof json.error === "object" &&
            json.error !== null &&
            typeof (json.error as Record<string, unknown>).message === "string"
          ) {
            const errObj = json.error as Record<string, unknown>;
            const codeSuffix = errObj.code ? ` (${errObj.code})` : "";
            return `${errObj.message}${codeSuffix}`;
          }
          // Flat error string: { error: "..." }
          if (typeof json.error === "string") {
            return json.error;
          }
          // Generic message string: { message: "..." }
          if (typeof json.message === "string") {
            return json.message;
          }
        }
        return rawBody;
      } catch {
        return rawBody;
      }
    }
  }

  // 2. Check for statusCode if response body was empty
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof (error as { statusCode: unknown }).statusCode === "number"
  ) {
    const statusCode = (error as { statusCode: number }).statusCode;
    const baseMsg =
      error instanceof Error &&
      error.message &&
      error.message !== "[object Object]"
        ? error.message
        : "HTTP Error";
    return `${baseMsg} (status: ${statusCode})`;
  }

  // 3. Check for nested Error.cause recursively
  if (error instanceof Error && error.cause) {
    const causeDetail = formatErrorDetail(error.cause);
    if (
      causeDetail &&
      causeDetail !== "[object Object]" &&
      causeDetail !== "Unknown error"
    ) {
      return `${error.message}: ${causeDetail}`;
    }
  }

  // 4. Standard Error instance with non-[object Object] message
  if (error instanceof Error) {
    const msg = error.message;
    if (msg && msg !== "[object Object]") {
      return msg;
    }
  }

  // 5. Raw plain object thrown
  if (typeof error === "object" && error !== null) {
    try {
      const str = JSON.stringify(error);
      if (str && str !== "{}" && str !== "[]") {
        return str;
      }
    } catch {
      // Fall through to String(error)
    }
  }

  const str = String(error);
  return str === "[object Object]" || str === "Error: [object Object]"
    ? "An unexpected upstream error occurred"
    : str;
}
