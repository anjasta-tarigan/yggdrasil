import { NextResponse } from "next/server";
import {
  installFromClawHub,
  installFromGithub,
  installFromSkillsSh,
} from "@/lib/skills/install-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/skills/install — install a skill from a registry.
 * Bodies:
 *  { registry: "clawhub", ref: "@owner/slug" | "slug", version? }
 *  { registry: "skillssh", id, source, skillId }
 *  { registry: "github", repo: "owner/repo"|url, path?, ref? }
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  const v = body as Record<string, unknown>;
  const str = (value: unknown, max = 512) =>
    typeof value === "string" && value.length > 0 && value.length <= max
      ? value.trim()
      : undefined;

  try {
    if (v.registry === "clawhub") {
      const ref = str(v.ref, 256);
      if (!ref) {
        return NextResponse.json(
          { error: "ref is required (slug or @owner/slug)." },
          { status: 400 }
        );
      }
      const result = await installFromClawHub(ref, { version: str(v.version, 64) });
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 502 });
      }
      return NextResponse.json({ skill: result.row, replaced: result.replaced, via: result.via });
    }

    if (v.registry === "skillssh") {
      const id = str(v.id, 512);
      const source = str(v.source, 256);
      const skillId = str(v.skillId, 256);
      if (!id || !source || !skillId) {
        return NextResponse.json(
          { error: "id, source and skillId are required." },
          { status: 400 }
        );
      }
      const result = await installFromSkillsSh({ id, source, skillId });
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 502 });
      }
      return NextResponse.json({ skill: result.row, replaced: result.replaced });
    }

    if (v.registry === "github") {
      const repo = str(v.repo, 512);
      if (!repo) {
        return NextResponse.json(
          { error: "repo is required ('owner/repo' or github.com URL)." },
          { status: 400 }
        );
      }
      const result = await installFromGithub({
        repo,
        path: str(v.path, 512),
        ref: str(v.ref, 256),
      });
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 502 });
      }
      return NextResponse.json({ skill: result.row, replaced: result.replaced });
    }

    return NextResponse.json(
      { error: "registry must be one of: clawhub, skillssh, github" },
      { status: 400 }
    );
  } catch (error) {
    console.error("[api/skills/install] POST error:", error);
    return NextResponse.json({ error: "Skill installation failed" }, { status: 500 });
  }
}
