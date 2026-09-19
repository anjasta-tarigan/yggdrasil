import { NextResponse } from "next/server";
import { syslog } from "@/lib/observability/log-store";

import fs from "node:fs/promises";
import path from "node:path";
import {
  getProject,
  resolveCanonicalProjectPath,
} from "@/lib/project-service";
import {
  isSensitivePath,
  isDefaultIgnoredPath,
} from "@/lib/ai/tools/file-security";
import type { ProjectFileEntry } from "@/lib/project-utils";
import { validateProjectApiRequest } from "../../guard";

export const dynamic = "force-dynamic";

export type { ProjectFileEntry };

/** Depth cap so a pathological tree cannot buffer unbounded results. */
const MAX_TREE_DEPTH = 8;
/** Hard cap on emitted entries; the UI renders a tree, not a full index. */
const MAX_TREE_ENTRIES = 5000;

async function walkDirectory(
  currentDir: string,
  canonicalRoot: string,
  depth: number
): Promise<ProjectFileEntry[]> {
  if (depth > MAX_TREE_DEPTH) return [];

  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const results: ProjectFileEntry[] = [];

  for (const entry of entries) {
    if (results.length >= MAX_TREE_ENTRIES) break;

    // Skip default-ignored dirs (node_modules/.git/…) and secret-bearing names
    // (.env, id_rsa, *.pem, .ssh, .aws …) — Rule 04 / Spec §3.5.
    if (
      isDefaultIgnoredPath(entry.name) ||
      isSensitivePath(path.join(currentDir, entry.name))
    ) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    const relPath = path.relative(canonicalRoot, fullPath).split(path.sep).join("/");

    // Skip symlinks whose canonical target escapes the workspace root.
    if (entry.isSymbolicLink()) {
      let canonicalTarget: string | null = null;
      try {
        canonicalTarget = await fs.realpath(fullPath);
      } catch {
        canonicalTarget = null;
      }
      if (
        canonicalTarget === null ||
        (canonicalTarget !== canonicalRoot &&
          !canonicalTarget.startsWith(canonicalRoot + path.sep))
      ) {
        continue;
      }
    }

    if (entry.isDirectory()) {
      results.push({
        path: relPath,
        isDirectory: true,
        size: 0,
      });
      const children = await walkDirectory(fullPath, canonicalRoot, depth + 1);
      results.push(...children);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(fullPath);
        results.push({
          path: relPath,
          isDirectory: false,
          size: stat.size,
        });
      } catch (err) {
        syslog("debug", "route", `Error: ${err instanceof Error ? err.message : String(err)}`);
        // Concurrent deletion ignore
      }
    }
  }

  return results;
}

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const guardResponse = validateProjectApiRequest(req);
  if (guardResponse) return guardResponse;

  const { id } = await context.params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // TOCTOU verification (Spec §3.4): Re-evaluate realpath on disk
  let canonicalRoot: string;
  try {
    canonicalRoot = await resolveCanonicalProjectPath(project.directoryPath);
  } catch (err) {
    syslog("debug", "route", `Error: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json(
      { error: "Project directory no longer exists on disk" },
      { status: 404 }
    );
  }

  try {
    const files = await walkDirectory(canonicalRoot, canonicalRoot, 0);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return NextResponse.json(files);
  } catch (error: unknown) {
    const err = error as Error;
    return NextResponse.json(
      { error: err.message || "Failed to list project files" },
      { status: 500 }
    );
  }
}
