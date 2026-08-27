import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  ALLOWED_REGISTRY_HOSTS,
  extractZipToSkillFiles,
  fetchBuffer,
  fetchJson,
  guardedFetch,
  RegistryError,
} from "../registries/http";
import {
  fetchSkillFromGithub,
  listRepoSkillDirs,
  parseGithubRepoRef,
} from "../registries/github";
import {
  downloadClawHubSkill,
  getClawHubSkill,
  parseClawHubRef,
  searchClawHub,
} from "../registries/clawhub";
import { downloadSkillsShSkill, searchSkillsSh } from "../registries/skillssh";

/* ── fetch mocking helpers ───────────────────────────────────────── */

type RouteMap = Record<string, { body: string | Uint8Array; init?: ResponseInit }>;

function mockFetch(routes: RouteMap): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, route] of Object.entries(routes)) {
      if (url.startsWith(pattern)) {
        // Copy into a fresh ArrayBuffer-backed view: undici's Response
        // consumes typed arrays directly (jsdom's Blob would not).
        const body =
          typeof route.body === "string" ? route.body : new Uint8Array(route.body);
        return new Response(body, { status: 200, ...route.init });
      }
    }
    return new Response(`no route for ${url}`, { status: 404 });
  }) as typeof fetch;
}

const SKILL_MD = "---\nname: demo\ndescription: Demo skill.\n---\nBody.";

/* ── http guards ─────────────────────────────────────────────────── */

describe("guardedFetch", () => {
  it("rejects non-HTTPS and non-allowlisted hosts before fetching", async () => {
    await expect(guardedFetch("http://clawhub.ai/x")).rejects.toThrow(/HTTPS/);
    await expect(guardedFetch("https://evil.example/x")).rejects.toThrow(/allowlist/);
    await expect(guardedFetch("https://evil.example/x")).rejects.toBeInstanceOf(RegistryError);
  });

  it("passes redirect: error to the fetch implementation", async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return new Response("ok");
    }) as typeof fetch;
    await guardedFetch("https://clawhub.ai/api/v1/skills", { fetchImpl });
    expect(seen?.redirect).toBe("error");
  });

  it("surfaces error bodies in the thrown message", async () => {
    const fetchImpl = (async () =>
      new Response("Ambiguous skill slug", { status: 409 })) as typeof fetch;
    await expect(
      guardedFetch("https://clawhub.ai/api/v1/download", { fetchImpl })
    ).rejects.toThrow(/409.*Ambiguous/);
  });

  it("exposes the expected allowlist", () => {
    expect(ALLOWED_REGISTRY_HOSTS.has("clawhub.ai")).toBe(true);
    expect(ALLOWED_REGISTRY_HOSTS.has("www.skills.sh")).toBe(true);
    expect(ALLOWED_REGISTRY_HOSTS.has("raw.githubusercontent.com")).toBe(true);
  });
});

describe("fetchJson / fetchBuffer", () => {
  it("parses JSON and enforces the byte cap", async () => {
    const fetchImpl = mockFetch({
      "https://clawhub.ai/api/v1/skills": { body: '{"ok":true}' },
    });
    const data = await fetchJson<{ ok: boolean }>("https://clawhub.ai/api/v1/skills", {
      fetchImpl,
    });
    expect(data.ok).toBe(true);

    await expect(
      fetchJson("https://clawhub.ai/api/v1/skills", { fetchImpl, maxBytes: 2 })
    ).rejects.toThrow(/size cap/);
  });

  it("returns bytes via fetchBuffer", async () => {
    const fetchImpl = mockFetch({
      "https://clawhub.ai/x": { body: "abc" },
    });
    const buf = await fetchBuffer("https://clawhub.ai/x", { fetchImpl });
    expect(buf.byteLength).toBe(3);
  });
});

describe("extractZipToSkillFiles", () => {
  it("extracts a flat zip", () => {
    const zip = zipSync({
      "SKILL.md": strToU8(SKILL_MD),
      "references/notes.md": strToU8("notes"),
    });
    const res = extractZipToSkillFiles(zip);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.files.map((f) => f.path).sort()).toEqual([
        "SKILL.md",
        "references/notes.md",
      ]);
    }
  });

  it("strips a single root folder prefix", () => {
    const zip = zipSync({
      "demo/SKILL.md": strToU8(SKILL_MD),
      "demo/scripts/run.sh": strToU8("#!/bin/sh"),
    });
    const res = extractZipToSkillFiles(zip);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.files.some((f) => f.path === "SKILL.md")).toBe(true);
      expect(res.files.some((f) => f.path === "scripts/run.sh")).toBe(true);
    }
  });

  it("rejects traversal paths, missing SKILL.md and corrupt archives", () => {
    const evil = zipSync({ "../evil.md": strToU8("x"), "SKILL.md": strToU8(SKILL_MD) });
    expect(extractZipToSkillFiles(evil).ok).toBe(false);

    const noMd = zipSync({ "readme.md": strToU8("x") });
    expect(extractZipToSkillFiles(noMd).ok).toBe(false);

    expect(extractZipToSkillFiles(new Uint8Array([1, 2, 3])).ok).toBe(false);
  });
});

/* ── github ──────────────────────────────────────────────────────── */

describe("parseGithubRepoRef", () => {
  it("parses shorthand and URL forms", () => {
    expect(parseGithubRepoRef("anthropics/skills")).toEqual({
      owner: "anthropics",
      repo: "skills",
    });
    expect(parseGithubRepoRef("anthropics/skills/skills/pdf")).toEqual({
      owner: "anthropics",
      repo: "skills",
      subpath: "skills/pdf",
    });
    expect(parseGithubRepoRef("https://github.com/anthropics/skills.git")).toEqual({
      owner: "anthropics",
      repo: "skills",
    });
    expect(parseGithubRepoRef("https://github.com/anthropics/skills/tree/main/skills/pdf")).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      subpath: "skills/pdf",
    });
  });

  it("rejects non-GitHub and malformed inputs", () => {
    expect(parseGithubRepoRef("https://gitlab.com/a/b")).toBeNull();
    expect(parseGithubRepoRef("justarepo")).toBeNull();
    expect(parseGithubRepoRef("")).toBeNull();
    expect(parseGithubRepoRef("bad owner/repo")).toBeNull();
  });
});

const TREE_RESPONSE = JSON.stringify({
  tree: [
    { path: "skills/pdf/SKILL.md", type: "blob" },
    { path: "skills/pdf/references/guide.md", type: "blob" },
    { path: "skills/docx/SKILL.md", type: "blob" },
    { path: "README.md", type: "blob" },
  ],
});

describe("github skill resolution", () => {
  it("lists top-level skill directories", async () => {
    const fetchImpl = mockFetch({
      "https://api.github.com/repos/anthropics/skills/git/trees/": { body: TREE_RESPONSE },
    });
    const entries = await listRepoSkillDirs(
      { owner: "anthropics", repo: "skills" },
      { fetchImpl }
    );
    expect(entries.map((e) => e.name)).toEqual(["docx", "pdf"]);
  });

  it("fetches a skill folder via raw files", async () => {
    const fetchImpl = mockFetch({
      "https://api.github.com/repos/anthropics/skills/git/trees/": { body: TREE_RESPONSE },
      "https://raw.githubusercontent.com/anthropics/skills/HEAD/skills/pdf/SKILL.md": {
        body: SKILL_MD,
      },
      "https://raw.githubusercontent.com/anthropics/skills/HEAD/skills/pdf/references/guide.md": {
        body: "guide",
      },
    });
    const files = await fetchSkillFromGithub(
      { owner: "anthropics", repo: "skills" },
      "skills/pdf",
      { fetchImpl }
    );
    expect(files.map((f) => f.path).sort()).toEqual(["SKILL.md", "references/guide.md"]);
  });
});

/* ── clawhub ─────────────────────────────────────────────────────── */

describe("parseClawHubRef", () => {
  it("accepts bare slugs and @owner/slug refs", () => {
    expect(parseClawHubRef("gifgrep")).toEqual({ slug: "gifgrep" });
    expect(parseClawHubRef("@awspace/pdf")).toEqual({ ownerHandle: "awspace", slug: "pdf" });
    expect(parseClawHubRef("@bad ref")).toBeNull();
    expect(parseClawHubRef("")).toBeNull();
  });
});

describe("clawhub client", () => {
  it("normalizes search results", async () => {
    const fetchImpl = mockFetch({
      "https://clawhub.ai/api/v1/search": {
        body: JSON.stringify({
          results: [
            {
              slug: "gifgrep",
              displayName: "GifGrep",
              summary: "Search GIFs",
              downloads: 100,
              ownerHandle: "steipete",
            },
          ],
        }),
      },
    });
    const results = await searchClawHub("gif", { fetchImpl });
    expect(results[0]).toMatchObject({ slug: "gifgrep", downloads: 100 });
  });

  it("downloads a hosted zip", async () => {
    const zip = zipSync({ "SKILL.md": strToU8(SKILL_MD) });
    const fetchImpl = mockFetch({
      "https://clawhub.ai/api/v1/download": {
        body: zip,
        init: { headers: { "content-type": "application/zip" } },
      },
    });
    const res = await downloadClawHubSkill("gifgrep", { fetchImpl });
    expect(res.via).toBe("clawhub-zip");
    expect(res.files[0].path).toBe("SKILL.md");
  });

  it("follows a GitHub handoff", async () => {
    const fetchImpl = mockFetch({
      "https://clawhub.ai/api/v1/download": {
        body: JSON.stringify({
          sourceRef: "public-github",
          repo: "anthropics/skills",
          commit: "abc123",
          path: "skills/pdf",
        }),
        init: { headers: { "content-type": "application/json" } },
      },
      "https://api.github.com/repos/anthropics/skills/git/trees/": { body: TREE_RESPONSE },
      "https://raw.githubusercontent.com/anthropics/skills/abc123/skills/pdf/SKILL.md": {
        body: SKILL_MD,
      },
      "https://raw.githubusercontent.com/anthropics/skills/abc123/skills/pdf/references/guide.md": {
        body: "guide",
      },
    });
    const res = await downloadClawHubSkill("@awspace/pdf", { fetchImpl });
    expect(res.via).toBe("github-handoff");
    expect(res.files.some((f) => f.path === "SKILL.md")).toBe(true);
  });

  it("surfaces ambiguous-slug errors", async () => {
    const fetchImpl = (async () =>
      new Response("Ambiguous skill slug", { status: 409 })) as typeof fetch;
    await expect(downloadClawHubSkill("pdf", { fetchImpl })).rejects.toThrow(/Ambiguous/);
  });

  it("fetches skill details including SKILL.md text", async () => {
    const fetchImpl = mockFetch({
      "https://clawhub.ai/api/v1/skills/gifgrep": {
        body: JSON.stringify({
          skill: { slug: "gifgrep", displayName: "GifGrep", description: SKILL_MD },
          latestVersion: { version: "1.0.1" },
          owner: { handle: "steipete" },
        }),
      },
    });
    const detail = await getClawHubSkill("gifgrep", { fetchImpl });
    expect(detail.skillMd).toBe(SKILL_MD);
    expect(detail.latestVersion).toBe("1.0.1");
  });
});

/* ── skills.sh ───────────────────────────────────────────────────── */

describe("skillssh client", () => {
  it("searches via the public web endpoint", async () => {
    const fetchImpl = mockFetch({
      "https://www.skills.sh/api/search": {
        body: JSON.stringify({
          query: "pdf",
          skills: [
            {
              id: "anthropics/skills/pdf",
              skillId: "pdf",
              name: "pdf",
              installs: 185982,
              source: "anthropics/skills",
            },
          ],
        }),
      },
    });
    const results = await searchSkillsSh("pdf", { fetchImpl });
    expect(results[0]).toMatchObject({
      id: "anthropics/skills/pdf",
      source: "anthropics/skills",
      installs: 185982,
    });
  });

  it("resolves a catalog entry through GitHub", async () => {
    const fetchImpl = mockFetch({
      "https://api.github.com/repos/anthropics/skills/git/trees/": { body: TREE_RESPONSE },
      "https://raw.githubusercontent.com/anthropics/skills/HEAD/skills/pdf/SKILL.md": {
        body: SKILL_MD,
      },
      "https://raw.githubusercontent.com/anthropics/skills/HEAD/skills/pdf/references/guide.md": {
        body: "guide",
      },
    });
    const res = await downloadSkillsShSkill(
      { source: "anthropics/skills", skillId: "pdf" },
      { fetchImpl }
    );
    expect(res.path).toBe("skills/pdf");
    expect(res.files.some((f) => f.path === "SKILL.md")).toBe(true);
  });

  it("errors clearly when the skill is not in the repo", async () => {
    const fetchImpl = mockFetch({
      "https://api.github.com/repos/anthropics/skills/git/trees/": { body: TREE_RESPONSE },
    });
    await expect(
      downloadSkillsShSkill({ source: "anthropics/skills", skillId: "ghost" }, { fetchImpl })
    ).rejects.toThrow(/not found/);
  });
});
