import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

export const dynamic = "force-dynamic";

/**
 * GET /api/projects/browse?path=/optional/path
 * Returns directories inside the specified path so user can browse/select a folder on host.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const requestedPath = searchParams.get("path");

  let currentPath: string;
  if (requestedPath && requestedPath.trim()) {
    currentPath = path.resolve(requestedPath.trim());
  } else {
    // Default starting locations: system workspace projects folder or user home
    const workspaceProjects = path.resolve(process.cwd(), "data", "projects");
    if (fsSync.existsSync(workspaceProjects)) {
      currentPath = workspaceProjects;
    } else {
      currentPath = os.homedir();
    }
  }

  try {
    const stat = await fs.stat(currentPath);
    if (!stat.isDirectory()) {
      currentPath = path.dirname(currentPath);
    }
  } catch {
    currentPath = os.homedir();
  }

  try {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    const directories: Array<{ name: string; path: string }> = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Exclude system / hidden hidden root dot-directories like .git if desired, but show standard folders
        directories.push({
          name: entry.name,
          path: path.join(currentPath, entry.name),
        });
      }
    }

    // Sort alphabetically, with hidden dotfolders at end or standard order
    directories.sort((a, b) => a.name.localeCompare(b.name));

    const parentPath = path.dirname(currentPath) !== currentPath ? path.dirname(currentPath) : null;

    return NextResponse.json({
      currentPath,
      parentPath,
      systemWorkspacePath: path.resolve(process.cwd(), "data", "projects"),
      homePath: os.homedir(),
      directories,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to browse directory" },
      { status: 500 }
    );
  }
}
