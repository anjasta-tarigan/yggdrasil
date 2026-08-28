/**
 * Guarded outbound HTTP for skill/plugin registries.
 *
 * Single-user self-hosted app, but registry fetches still follow the
 * MCP-route SSRF posture: HTTPS only, a fixed host allowlist, redirects
 * rejected, timeouts and byte caps on every response.
 */

import { unzipSync } from "fflate";
import {
  MAX_SKILL_FILES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_TOTAL_BYTES,
  sanitizeSkillFilePath,
  type SkillFile,
} from "../config";

/** Hosts the registry layer is allowed to talk to. */
export const ALLOWED_REGISTRY_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "clawhub.ai",
  "skills.sh",
  "www.skills.sh",
]);

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 60 * 1024 * 1024;

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export interface GuardedFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * fetch() with allowlist + timeout + size cap. Redirects are rejected
 * (`redirect: "error"`) so an allowlisted host cannot bounce the
 * request to an internal address.
 */
export async function guardedFetch(
  url: string,
  options: GuardedFetchOptions = {}
): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RegistryError(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new RegistryError(`Only HTTPS URLs are allowed (got ${parsed.protocol}).`);
  }
  if (!ALLOWED_REGISTRY_HOSTS.has(parsed.hostname)) {
    throw new RegistryError(`Host not in the registry allowlist: ${parsed.hostname}`);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  );

  let response: Response;
  try {
    response = await fetchImpl(parsed.toString(), {
      redirect: "error",
      signal: controller.signal,
      headers: {
        "user-agent": "yggdrasil/0.1 (skills-plugins)",
        ...(options.headers ?? {}),
      },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new RegistryError(`Request timed out: ${parsed.hostname}`);
    }
    throw new RegistryError(
      `Request to ${parsed.hostname} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Include a short body snippet — registries return useful error
    // messages (e.g. ClawHub's ambiguous-slug guidance).
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300).trim();
    } catch {
      // Body unreadable; keep the bare status.
    }
    throw new RegistryError(
      `${parsed.hostname} returned HTTP ${response.status} for ${parsed.pathname}${detail ? `: ${detail}` : ""}`,
      response.status
    );
  }
  return response;
}

/** Read a JSON body with a byte cap (default 10 MB). */
export async function fetchJson<T>(
  url: string,
  options: GuardedFetchOptions & { maxBytes?: number } = {}
): Promise<T> {
  const response = await guardedFetch(url, options);
  const text = await readCappedText(response, options.maxBytes ?? 10 * 1024 * 1024);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RegistryError(`Invalid JSON from ${new URL(url).hostname}`);
  }
}

/** Read a binary body with a byte cap. */
export async function fetchBuffer(
  url: string,
  options: GuardedFetchOptions & { maxBytes?: number } = {}
): Promise<Uint8Array> {
  const response = await guardedFetch(url, options);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new RegistryError(
      `Response exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB cap.`
    );
  }
  return buffer;
}

async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new RegistryError("Response exceeds the size cap.");
  }
  return new TextDecoder("utf-8").decode(buffer);
}

/**
 * Extract a ZIP archive into a path→content map with traversal guards
 * and size caps. When every entry lives under a single top-level
 * folder, that folder prefix is stripped (common registry packaging).
 */
export function extractZipToFileMap(
  zipBytes: Uint8Array,
  limits: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number } = {}
):
  | { ok: true; files: Map<string, string>; strippedPrefix: string }
  | { ok: false; error: string } {
  const maxFiles = limits.maxFiles ?? MAX_SKILL_FILES;
  const maxFileBytes = limits.maxFileBytes ?? MAX_SKILL_FILE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_SKILL_TOTAL_BYTES;

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch (err) {
    return {
      ok: false,
      error: `Could not unzip archive: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const rawPaths = Object.keys(entries).filter((p) => !p.endsWith("/"));
  if (rawPaths.length === 0) return { ok: false, error: "Archive is empty." };
  if (rawPaths.length > maxFiles) {
    return { ok: false, error: `Archive has too many files (max ${maxFiles}).` };
  }

  // Detect a single common root folder (e.g. "my-bundle/file.md").
  const tops = new Set(rawPaths.map((p) => p.split("/")[0]));
  let stripPrefix = "";
  if (tops.size === 1) {
    const prefix = [...tops][0];
    // Only a folder prefix is stripped — a root-level file (e.g. a
    // bare "SKILL.md") is its own top entry and never matches.
    if (rawPaths.every((p) => p.startsWith(`${prefix}/`))) {
      stripPrefix = `${prefix}/`;
    }
  }

  const files = new Map<string, string>();
  let totalBytes = 0;
  for (const rawPath of rawPaths) {
    const relative = stripPrefix && rawPath.startsWith(stripPrefix)
      ? rawPath.slice(stripPrefix.length)
      : rawPath;
    if (!relative) continue;
    const path = sanitizeSkillFilePath(relative);
    if (!path) return { ok: false, error: `Unsafe path in archive: ${rawPath}` };
    const bytes = entries[rawPath];
    if (bytes.byteLength > maxFileBytes) {
      return { ok: false, error: `File too large in archive: ${path}` };
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > maxTotalBytes) {
      return { ok: false, error: "Archive exceeds the total size cap." };
    }
    files.set(path, new TextDecoder("utf-8").decode(bytes));
  }
  return { ok: true, files, strippedPrefix: stripPrefix };
}

/**
 * Extract a ZIP archive into skill files; requires a root SKILL.md.
 */
export function extractZipToSkillFiles(
  zipBytes: Uint8Array
): { ok: true; files: SkillFile[] } | { ok: false; error: string } {
  const result = extractZipToFileMap(zipBytes);
  if (!result.ok) return result;
  if (!result.files.has("SKILL.md")) {
    return { ok: false, error: "Archive does not contain a SKILL.md at its root." };
  }
  const files: SkillFile[] = [...result.files.entries()].map(([path, content]) => ({
    path,
    content,
  }));
  files.sort((a, b) =>
    a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : 0
  );
  return { ok: true, files };
}
