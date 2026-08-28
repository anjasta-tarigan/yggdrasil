import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getProject, validateAndResolveProjectPath } from "@/lib/project-service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  children?: FileTreeNode[];
}

const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
  ".DS_Store",
]);

async function buildTree(
  root: string,
  relativeDir = "",
  currentDepth = 0,
  maxDepth = 4
): Promise<FileTreeNode[]> {
  if (currentDepth > maxDepth) return [];
  const currentDir = path.resolve(root, relativeDir);
  const entries = await fs.readdir(currentDir, { withFileTypes: true });

  const nodes: FileTreeNode[] = [];
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) continue;

    const entryRelPath = path.join(relativeDir, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      const children = await buildTree(root, entryRelPath, currentDepth + 1, maxDepth);
      nodes.push({
        name: entry.name,
        path: entryRelPath,
        isDirectory: true,
        children,
      });
    } else if (entry.isFile()) {
      nodes.push({
        name: entry.name,
        path: entryRelPath,
        isDirectory: false,
      });
    }
  }

  return nodes.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * GET /api/projects/[id]/files - Returns the file tree of the project directory
 */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  try {
    const tree = await buildTree(project.directoryPath);
    return NextResponse.json({ tree });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load files" },
      { status: 500 }
    );
  }
}
