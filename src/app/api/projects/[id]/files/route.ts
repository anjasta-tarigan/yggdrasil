import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getProject,
  resolveCanonicalProjectPath,
} from "@/lib/project-service";
import { validateProjectApiRequest } from "../../guard";

export const dynamic = "force-dynamic";

export interface ProjectFileEntry {
  path: string;
  isDirectory: boolean;
  size: number;
}

const IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
]);

async function walkDirectory(
  currentDir: string,
  canonicalRoot: string
): Promise<ProjectFileEntry[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const results: ProjectFileEntry[] = [];

  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    const relPath = path.relative(canonicalRoot, fullPath).split(path.sep).join("/");

    if (entry.isDirectory()) {
      results.push({
        path: relPath,
        isDirectory: true,
        size: 0,
      });
      const children = await walkDirectory(fullPath, canonicalRoot);
      results.push(...children);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(fullPath);
        results.push({
          path: relPath,
          isDirectory: false,
          size: stat.size,
        });
      } catch {
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
  } catch {
    return NextResponse.json(
      { error: "Project directory no longer exists on disk" },
      { status: 404 }
    );
  }

  try {
    const files = await walkDirectory(canonicalRoot, canonicalRoot);
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
