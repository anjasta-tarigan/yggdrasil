import path from "node:path";
import fs from "node:fs/promises";

const SENSITIVE_BASENAME_PATTERNS = [
  /^\.env/i,
  /^id_(rsa|ed25519|ecdsa|dsa)/i,
  /\.(pem|key|p12|pfx|keystore|crt)$/i,
  /^\.(npmrc|pypirc|netrc)$/i,
];

const SENSITIVE_PATH_PATTERNS = [
  /(^|[/\\])\.aws([/\\]|$)/i,
  /(^|[/\\])\.ssh([/\\]|$)/i,
  /(^|[/\\])\.docker[/\\]config\.json$/i,
  /(^|[/\\])\.git[/\\]config$/i,
  /\/etc\/(shadow|passwd)$/i,
];

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
]);

export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = path.basename(normalized);

  if (SENSITIVE_BASENAME_PATTERNS.some((p) => p.test(basename))) {
    return true;
  }
  if (SENSITIVE_PATH_PATTERNS.some((p) => p.test(normalized))) {
    return true;
  }
  return false;
}

export function isDefaultIgnoredPath(filePath: string): boolean {
  const segments = filePath.replace(/\\/g, "/").split("/");
  return segments.some((segment) => IGNORED_DIRECTORIES.has(segment));
}

export async function assertSafePath(
  inputPath: string,
  customWorkspaceRoot?: string
): Promise<string> {
  const root = customWorkspaceRoot
    ? path.resolve(customWorkspaceRoot)
    : process.cwd();
  const canonicalRoot = await fs.realpath(root);

  const target = path.resolve(root, inputPath);

  // Check if target or any link in target exists
  let canonicalTarget: string;
  try {
    canonicalTarget = await fs.realpath(target);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Check if target is a dangling symlink
      try {
        const lstat = await fs.lstat(target);
        if (lstat.isSymbolicLink()) {
          // It's a dangling symlink, resolve readlink
          const linkDest = await fs.readlink(target);
          // Canonicalize the directory containing the symlink
          let canonicalTargetDir: string;
          try {
            canonicalTargetDir = await fs.realpath(path.dirname(target));
          } catch {
            canonicalTargetDir = path.dirname(target);
          }
          const resolvedLink = path.resolve(canonicalTargetDir, linkDest);
          if (!resolvedLink.startsWith(canonicalRoot + path.sep) && resolvedLink !== canonicalRoot) {
            throw new Error(`Security Violation: Path escapes workspace root: ${inputPath}`);
          }
        }
      } catch (lstatErr: unknown) {
        if ((lstatErr as NodeJS.ErrnoException).code !== "ENOENT") throw lstatErr;
      }

      // Non-existent target file: resolve closest existing parent ancestor
      let currentDir = path.dirname(target);
      let canonicalParent: string | null = null;
      while (currentDir !== path.dirname(currentDir)) {
        try {
          canonicalParent = await fs.realpath(currentDir);
          if (
            !canonicalParent.startsWith(canonicalRoot + path.sep) &&
            canonicalParent !== canonicalRoot
          ) {
            throw new Error(`Security Violation: Path escapes workspace root: ${inputPath}`);
          }
          break;
        } catch {
          currentDir = path.dirname(currentDir);
        }
      }

      if (canonicalParent) {
        canonicalTarget = path.resolve(canonicalParent, path.relative(currentDir, target));
      } else {
        canonicalTarget = target;
      }
    } else {
      throw err;
    }
  }

  if (
    !canonicalTarget.startsWith(canonicalRoot + path.sep) &&
    canonicalTarget !== canonicalRoot
  ) {
    throw new Error(`Security Violation: Path escapes workspace root: ${inputPath}`);
  }

  if (isSensitivePath(canonicalTarget) || isSensitivePath(inputPath)) {
    throw new Error(`Security Violation: Access to sensitive file is blocked: ${inputPath}`);
  }

  return canonicalTarget;
}

export async function filterSafePaths(
  paths: string[],
  workspaceRoot?: string
): Promise<string[]> {
  const safe: string[] = [];
  for (const p of paths) {
    try {
      if (!isSensitivePath(p) && !isDefaultIgnoredPath(p)) {
        await assertSafePath(p, workspaceRoot);
        safe.push(p);
      }
    } catch {
      // Omit paths that escape or are blocked
    }
  }
  return safe;
}
