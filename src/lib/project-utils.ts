const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Validates and sanitizes a project name for filesystem and directory safety.
 *
 * Enforces:
 * 1. Trimmed, lowercased, length between 1 and 64 characters.
 * 2. Replaces characters outside [a-z0-9_-] with hyphens, collapses consecutive hyphens.
 * 3. Strictly forbids path traversal sequences (.., /, \).
 * 4. Strictly forbids reserved OS filenames (con, prn, aux, nul, com1-9, lpt1-9).
 */
export function sanitizeProjectName(name: string): string {
  if (typeof name !== "string") {
    throw new Error("Project name must be a string");
  }

  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Project name cannot be empty");
  }

  if (trimmed.length > 64) {
    throw new Error("Project name must not exceed 64 characters");
  }

  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("Path traversal sequences are not allowed in project names");
  }

  if (RESERVED_NAMES.test(trimmed)) {
    throw new Error(`Reserved OS name "${trimmed}" cannot be used as project name`);
  }

  const sanitized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!sanitized || sanitized.length > 64) {
    throw new Error("Project name must be between 1 and 64 valid characters");
  }

  if (RESERVED_NAMES.test(sanitized)) {
    throw new Error(`Reserved OS name "${sanitized}" cannot be used as project name`);
  }

  return sanitized;
}

/**
 * Generates a safe preview of the sanitized project name for UI feedback
 * without throwing when the user is partially typing.
 */
export function previewSanitizedProjectName(name: string): string {
  if (!name || typeof name !== "string") return "";
  const trimmed = name.trim();
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) {
    return "(invalid path characters)";
  }
  if (RESERVED_NAMES.test(trimmed)) {
    return "(reserved name)";
  }
  const sanitized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return sanitized;
}
