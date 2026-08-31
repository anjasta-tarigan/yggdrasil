/**
 * Deterministic tool-call repair for common model JSON mistakes.
 *
 * Some models emit tool-call arguments that don't match the tool's JSON
 * Schema in predictable ways (e.g. a single string where an array of
 * strings is required, or the whole input wrapped/missing). The AI SDK
 * surfaces these as InvalidToolInputError and — without repairToolCall —
 * the call is marked invalid, never executes, and the model just gets
 * an error message back ("Could not execute tool(s): …").
 *
 * Instead of burning an LLM round-trip on repair, this module fixes the
 * known-good shapes deterministically against the tool's schema:
 *
 *  1. array-typed fields sent as a single value  → [value]
 *  2. array-typed fields sent as a delimited/    → split
 *     newline/comma list                          string
 *  3. string-typed fields sent as a number or    → String(value)
 *     boolean
 *
 * If nothing can be fixed, return null — the SDK then falls back to its
 * default behavior (invalid call, error surfaced to the model).
 */

import type { JSONSchema7 } from "ai";

/** Minimal structural type of a provider tool call (the AI SDK's
 *  LanguageModelV4ToolCall is not re-exported from "ai", and only these
 *  three fields matter for input repair). */
type ProviderToolCall = {
  toolCallId: string;
  toolName: string;
  /** Stringified JSON object with the tool call arguments. */
  input: string;
};

/** Loose JSON-Schema node as provided by the SDK's inputSchema(). */
type SchemaNode = {
  type?: string | string[];
  items?: { type?: string | string[] };
};

/** Coerce one value to the array-of-strings shape a field expects. */
function coerceToStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const allStrings = value.every((v) => typeof v === "string");
    if (allStrings) return value as string[];
    return undefined;
  }
  if (typeof value === "string") {
    // Delimited lists ("a, b", newline-separated) become real arrays.
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.includes("\n")) {
      const parts = trimmed
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length > 1) return parts;
    }
    const commaParts = trimmed
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (commaParts.length > 1) return commaParts;
    return [trimmed];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  return undefined;
}

/** Coerce scalars that arrived as the wrong JSON type to strings. */
function coerceToString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/**
 * Attempt a deterministic repair of one tool call's input against its
 * JSON Schema. Returns a new tool call (same ids, fixed input string)
 * or null when the input cannot be salvaged.
 */
export function repairToolCallInput(
  toolCall: Pick<ProviderToolCall, "toolCallId" | "toolName" | "input">,
  schema: JSONSchema7
): Pick<ProviderToolCall, "toolCallId" | "toolName" | "input"> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.input);
  } catch {
    return null; // not JSON at all — nothing deterministic to do
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null; // repairs only apply to object-shaped inputs
  }

  const record = parsed as Record<string, unknown>;
  const properties =
    typeof schema === "object" && schema !== null && schema.properties
      ? (schema.properties as Record<string, SchemaNode>)
      : {};

  let changed = false;
  for (const [key, fieldSchema] of Object.entries(properties)) {
    if (!(key in record)) continue;
    const value = record[key];
    if (value === undefined || value === null) continue;

    const types = Array.isArray(fieldSchema.type)
      ? fieldSchema.type
      : fieldSchema.type
        ? [fieldSchema.type]
        : [];
    const itemType = fieldSchema.items?.type;
    const itemTypes = Array.isArray(itemType)
      ? itemType
      : itemType
        ? [itemType]
        : [];

    if (types.includes("array") && !Array.isArray(value)) {
      const itemIsString =
        itemTypes.length === 0 || itemTypes.includes("string");
      const fixed = itemIsString ? coerceToStringArray(value) : undefined;
      if (fixed === undefined) continue;
      record[key] = fixed;
      changed = true;
      continue;
    }

    if (types.includes("string") && typeof value !== "string") {
      // Only fix when the field is not also an array that happened to
      // arrive correctly (schema type lists like ["string","array"]).
      if (!Array.isArray(value) || !types.includes("array")) {
        const fixed = coerceToString(value);
        if (fixed === undefined) continue;
        record[key] = fixed;
        changed = true;
      }
    }
  }

  if (!changed) return null;
  return {
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: JSON.stringify(record),
  };
}
