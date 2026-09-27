import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression: the file tree previously truncated alphabetically — because
 * `node_modules`-style dirs (e.g. `.venv`) sort before normal dirs (`src`,
 * `tests`) and the recursive walk filled the 5000-entry cap while still inside
 * `.venv`, every root-level entry after it (README, src, tests, …) was dropped,
 * leaving only dot-files (`.` sorts first). The tree must always include every
 * root-level entry, and shallow entries before deep ones.
 */

const fsMock = vi.hoisted(() => {
  const entries = new Map<string, Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean }>>();
  return {
    readdir: vi.fn(async (p: string) => entries.get(p) ?? []),
    stat: vi.fn(async () => ({ size: 10 })),
    realpath: vi.fn(async (p: string) => p),
    setTree(root: string, tree: Record<string, string[]>) {
      entries.clear();
      for (const [dir, names] of Object.entries(tree)) {
        entries.set(
          dir,
          names.map((name) => {
            const isDir = name.endsWith("/");
            return {
              name: isDir ? name.slice(0, -1) : name,
              isDirectory: () => isDir,
              isFile: () => !isDir,
              isSymbolicLink: () => false,
            };
          })
        );
      }
    },
  };
});

vi.mock("node:fs/promises", () => ({
  default: {
    readdir: fsMock.readdir,
    stat: fsMock.stat,
    realpath: fsMock.realpath,
  },
  readdir: fsMock.readdir,
  stat: fsMock.stat,
  realpath: fsMock.realpath,
}));

vi.mock("@/lib/project-service", () => ({
  getProject: vi.fn(async () => ({ directoryPath: "/proj" })),
  resolveCanonicalProjectPath: vi.fn(async (p: string) => p),
}));

vi.mock("@/lib/observability/log-store", () => ({
  syslog: vi.fn(),
}));

function dirent(name: string, dir: boolean) {
  return {
    name,
    isDirectory: () => dir,
    isFile: () => !dir,
    isSymbolicLink: () => false,
  };
}

describe("GET /api/projects/:id/files", () => {
  beforeEach(() => {
    fsMock.readdir.mockClear();
    fsMock.setTree("/proj", {
      "/proj": [".venv/", "src/", "tests/", "README.md", ".gitignore"],
      "/proj/.venv": Array.from({ length: 6000 }, (_, i) => `pkg${i}.js`),
      "/proj/src": ["index.ts", "app.ts"],
      "/proj/tests": ["smoke.test.ts"],
    });
  });

  it("always includes every root-level entry, not just dot-files", async () => {
    const { GET } = await import("../route");
    const res = await GET(
      // Loopback host so the real project API guard treats it as local (the
      // in-app browser UI sends no Authorization header either).
      new Request("http://127.0.0.1:3000/api/projects/p1/files", {
        headers: { origin: "http://127.0.0.1:3000" },
      }),
      { params: Promise.resolve({ id: "p1" }) }
    );
    if (res.status !== 200) console.log("BODY:", JSON.stringify(await res.json()));
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ path: string }>;
    const rootPaths = data.filter((e) => !e.path.includes("/")).map((e) => e.path);
    expect(rootPaths).toEqual(
      expect.arrayContaining([".venv", "src", "tests", "README.md", ".gitignore"])
    );
    // The deep .venv contents are capped, but root entries are never dropped.
    expect(rootPaths).not.toContain("pkg0.js");
    // src and tests survived even though .venv (alphabetically first) is huge.
    expect(data.some((e) => e.path === "src/index.ts")).toBe(true);
    expect(data.some((e) => e.path === "tests/smoke.test.ts")).toBe(true);
  });
});
