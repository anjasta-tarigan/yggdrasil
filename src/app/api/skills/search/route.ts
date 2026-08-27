import { NextResponse } from "next/server";
import { listClawHubSkills, searchClawHub } from "@/lib/skills/registries/clawhub";
import { listRepoSkillDirs, parseGithubRepoRef } from "@/lib/skills/registries/github";
import { RegistryError } from "@/lib/skills/registries/http";
import { searchSkillsSh } from "@/lib/skills/registries/skillssh";

export const dynamic = "force-dynamic";

/**
 * GET /api/skills/search — registry search/browse passthrough.
 *  ?registry=clawhub&q=…            search ClawHub
 *  ?registry=clawhub&browse=1&sort=&cursor=   browse the catalog
 *  ?registry=skillssh&q=…           search skills.sh
 *  ?registry=github&repo=owner/repo list skills in a GitHub repo
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const registry = url.searchParams.get("registry") ?? "";
  const q = url.searchParams.get("q") ?? "";

  try {
    if (registry === "clawhub") {
      if (url.searchParams.get("browse") === "1") {
        const sort = url.searchParams.get("sort");
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const validSorts = [
          "updated",
          "recommended",
          "createdAt",
          "downloads",
          "stars",
          "name",
          "trending",
        ] as const;
        const sortValue = validSorts.find((s) => s === sort) ?? "recommended";
        const result = await listClawHubSkills({
          sort: sortValue,
          cursor,
          limit: 24,
        });
        return NextResponse.json({ registry, ...result });
      }
      if (q.trim().length === 0) {
        return NextResponse.json({ registry, results: [] });
      }
      const results = await searchClawHub(q, { limit: 24 });
      return NextResponse.json({ registry, results });
    }

    if (registry === "skillssh") {
      if (q.trim().length < 2) {
        return NextResponse.json({ registry, results: [] });
      }
      const results = await searchSkillsSh(q);
      return NextResponse.json({ registry, results });
    }

    if (registry === "github") {
      const repo = url.searchParams.get("repo") ?? "";
      const ref = parseGithubRepoRef(repo);
      if (!ref) {
        return NextResponse.json(
          { error: "Provide repo as 'owner/repo' or a github.com URL." },
          { status: 400 }
        );
      }
      const entries = await listRepoSkillDirs(ref);
      return NextResponse.json({
        registry,
        repo: `${ref.owner}/${ref.repo}`,
        ref: ref.ref ?? "HEAD",
        skills: entries,
      });
    }

    return NextResponse.json(
      { error: "registry must be one of: clawhub, skillssh, github" },
      { status: 400 }
    );
  } catch (error) {
    if (error instanceof RegistryError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    console.error("[api/skills/search] GET error:", error);
    return NextResponse.json({ error: "Registry search failed" }, { status: 500 });
  }
}
