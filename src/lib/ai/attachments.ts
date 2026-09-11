import type { UIMessage } from "ai";

/**
 * Known text & code file extensions mapped to markdown syntax highlighting identifiers.
 */
const KNOWN_CODE_EXTENSIONS: Record<string, string> = {
  // TypeScript / JavaScript
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",

  // Python
  py: "python",
  pyw: "python",
  ipynb: "json",

  // Web / Config / Styles
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  svg: "xml",

  // Systems / Backend
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  cs: "csharp",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  swift: "swift",
  rb: "ruby",
  php: "php",
  lua: "lua",
  zig: "zig",
  dart: "dart",
  erl: "erlang",
  ex: "elixir",
  exs: "elixir",
  clj: "clojure",
  hs: "haskell",

  // Shell / Ops / Env
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  env: "dotenv",
  dockerfile: "dockerfile",
  makefile: "makefile",

  // Database / Data
  sql: "sql",
  csv: "csv",
  tsv: "tsv",

  // Documentation / Plain Text
  md: "markdown",
  mdx: "mdx",
  txt: "text",
  log: "text",
  diff: "diff",
  patch: "diff",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
};

/**
 * Exact filenames without extensions or with dot prefixes that represent code/config.
 */
const KNOWN_CODE_FILENAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
  procfile: "yaml",
  vagrantfile: "ruby",
  ".env": "dotenv",
  ".env.local": "dotenv",
  ".env.development": "dotenv",
  ".env.production": "dotenv",
  ".env.test": "dotenv",
  ".gitignore": "gitignore",
  ".dockerignore": "dockerignore",
  ".prettierrc": "json",
  ".eslintrc": "json",
};

/**
 * Determines whether a file attachment represents readable text or source code
 * based on its MIME type and/or filename.
 */
export function isTextOrCodeMediaType(
  mediaType?: string,
  filename?: string
): boolean {
  const cleanMediaType = mediaType?.toLowerCase().trim() || "";
  const cleanFilename = filename?.toLowerCase().trim() || "";

  // 1. Explicitly check if MIME type is text/* or a known code MIME type
  if (
    cleanMediaType.startsWith("text/") ||
    cleanMediaType === "application/json" ||
    cleanMediaType === "application/javascript" ||
    cleanMediaType === "application/x-javascript" ||
    cleanMediaType === "application/typescript" ||
    cleanMediaType === "application/x-typescript" ||
    cleanMediaType === "application/xml" ||
    cleanMediaType === "application/yaml" ||
    cleanMediaType === "application/x-yaml" ||
    cleanMediaType === "application/sql" ||
    cleanMediaType === "application/x-sql" ||
    cleanMediaType === "application/graphql" ||
    cleanMediaType === "application/x-sh" ||
    cleanMediaType === "application/x-csh"
  ) {
    return true;
  }

  // 2. Reject binary media types early
  if (
    cleanMediaType.startsWith("image/") ||
    cleanMediaType.startsWith("audio/") ||
    cleanMediaType.startsWith("video/") ||
    cleanMediaType === "application/pdf" ||
    cleanMediaType === "application/zip" ||
    cleanMediaType === "application/x-zip-compressed" ||
    cleanMediaType === "application/x-tar" ||
    cleanMediaType === "application/gzip" ||
    cleanMediaType === "application/x-bzip2" ||
    cleanMediaType === "application/x-7z-compressed" ||
    cleanMediaType === "application/x-rar-compressed" ||
    cleanMediaType === "application/wasm"
  ) {
    return false;
  }

  // 3. Check filename against known code filenames
  if (cleanFilename) {
    const base = cleanFilename.split(/[/\\]/).pop() || cleanFilename;
    if (KNOWN_CODE_FILENAMES[base]) {
      return true;
    }

    const dotIndex = base.lastIndexOf(".");
    if (dotIndex !== -1 && dotIndex < base.length - 1) {
      const ext = base.slice(dotIndex + 1);
      if (KNOWN_CODE_EXTENSIONS[ext]) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Infers markdown code block language from filename or mediaType.
 */
function inferLanguage(filename?: string, mediaType?: string): string {
  const cleanFilename = filename?.toLowerCase().trim() || "";
  const cleanMediaType = mediaType?.toLowerCase().trim() || "";

  if (cleanFilename) {
    const base = cleanFilename.split(/[/\\]/).pop() || cleanFilename;
    if (KNOWN_CODE_FILENAMES[base]) {
      return KNOWN_CODE_FILENAMES[base];
    }
    const dotIndex = base.lastIndexOf(".");
    if (dotIndex !== -1 && dotIndex < base.length - 1) {
      const ext = base.slice(dotIndex + 1);
      if (KNOWN_CODE_EXTENSIONS[ext]) {
        return KNOWN_CODE_EXTENSIONS[ext];
      }
    }
  }

  if (cleanMediaType) {
    if (cleanMediaType.includes("typescript")) return "typescript";
    if (cleanMediaType.includes("javascript")) return "javascript";
    if (cleanMediaType.includes("json")) return "json";
    if (cleanMediaType.includes("python")) return "python";
    if (cleanMediaType.includes("markdown")) return "markdown";
    if (cleanMediaType.includes("html")) return "html";
    if (cleanMediaType.includes("css")) return "css";
    if (cleanMediaType.includes("xml") || cleanMediaType.includes("svg")) return "xml";
    if (cleanMediaType.includes("yaml")) return "yaml";
    if (cleanMediaType.includes("sql")) return "sql";
    if (cleanMediaType.includes("csv")) return "csv";
  }

  return "text";
}

/**
 * Decodes a base64 string to UTF-8 text in both Node (Buffer) and browser
 * (atob + TextDecoder) runtimes. The client pre-compacts the model-visible
 * history before every send, so it must produce the exact same decoded
 * payload the server would — a single implementation keeps both sides'
 * token estimates identical and the server guard converged.
 */
function decodeBase64ToUtf8(value: string): string | null {
  try {
    if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
      return Buffer.from(value, "base64").toString("utf-8");
    }
    // Browser fallback: atob yields latin-1 bytes; transpose to UTF-8.
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decodes UTF-8 text content from a data URL (`data:[<mediatype>][;base64],<data>`).
 * Returns null if the URL is invalid or cannot be decoded.
 */
export function decodeDataUrlContent(dataUrl: string): string | null {
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return null;
  }

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1 || commaIndex === dataUrl.length - 1) {
    return null;
  }

  const header = dataUrl.slice(5, commaIndex);
  const rawData = dataUrl.slice(commaIndex + 1);

  const isBase64 = header.toLowerCase().includes(";base64");

  try {
    if (isBase64) {
      return decodeBase64ToUtf8(rawData);
    } else {
      return decodeURIComponent(rawData);
    }
  } catch {
    return null;
  }
}

/**
 * Formats decoded file content into a structured markdown block for model ingestion.
 */
export function formatDecodedFileBlock(
  filename: string | undefined,
  mediaType: string | undefined,
  content: string
): string {
  const displayLabel = filename || "attachment";
  const typeLabel = mediaType ? ` (${mediaType})` : "";
  const lang = inferLanguage(filename, mediaType);

  return `[Attached File: ${displayLabel}${typeLabel}]\n\`\`\`${lang}\n${content}\n\`\`\``;
}

/**
 * Scans incoming messages (specifically user messages) for `type: "file"` parts.
 *
 * If a file is recognized as text or source code, its content is decoded from its data URL
 * and merged into the message text as a structured markdown block (`[Attached File: ...]`).
 * Image files (`image/*`) and non-text files are preserved as native file parts so multimodal
 * vision models can process them.
 */
export async function processIncomingMessageAttachments(
  messages: UIMessage[]
): Promise<UIMessage[]> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const processedMessages: UIMessage[] = [];

  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.parts)) {
      processedMessages.push(message);
      continue;
    }

    const newParts: UIMessage["parts"] = [];
    const decodedFileBlocks: string[] = [];

    for (const part of message.parts) {
      if (part.type === "file") {
        const filePart = part as {
          type: "file";
          filename?: string;
          mediaType?: string;
          url: string;
        };

        if (isTextOrCodeMediaType(filePart.mediaType, filePart.filename)) {
          const decoded = decodeDataUrlContent(filePart.url);
          if (decoded !== null) {
            decodedFileBlocks.push(
              formatDecodedFileBlock(
                filePart.filename,
                filePart.mediaType,
                decoded
              )
            );
            // Decoded file content has been extracted into markdown text, do not retain as raw file part
            continue;
          }
        }
      }

      // Preserve non-text file parts (e.g. images) and other UIPart types
      newParts.push(part);
    }

    if (decodedFileBlocks.length > 0) {
      const mergedBlock = decodedFileBlocks.join("\n\n");
      const existingTextIndex = newParts.findIndex((p) => p.type === "text");

      if (existingTextIndex !== -1) {
        const existing = newParts[existingTextIndex] as {
          type: "text";
          text: string;
        };
        newParts[existingTextIndex] = {
          ...existing,
          text: `${existing.text}\n\n${mergedBlock}`,
        };
      } else {
        newParts.unshift({
          type: "text",
          text: mergedBlock,
        });
      }
    }

    processedMessages.push({
      ...message,
      parts: newParts,
    });
  }

  return processedMessages;
}
