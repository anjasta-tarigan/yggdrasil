import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as schema from "@/db/schema";
import { setupFtsAndTriggers } from "@/db/init";
import type { AppDatabase } from "@/db";
import {
  getSkillBody,
  getSkillByName,
  installSkill,
  listSkillFiles,
  listSkills,
  readSkillFile,
  setSkillEnabled,
  uninstallSkill,
} from "../store";

const SKILL_MD = `---
name: test-skill
description: A skill used in unit tests.
---

Do the test thing. Read references/notes.md when needed.
`;

describe("Skill store", () => {
  let sqlite: Database.Database;
  let db: AppDatabase;
  let root: string;
  const opts = () => ({ db, root });

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    setupFtsAndTriggers(sqlite);
    db = drizzle(sqlite, { schema }) as AppDatabase;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-store-"));
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("installs a skill to disk and registry", async () => {
    const res = await installSkill(
      {
        name: "test-skill",
        files: [
          { path: "SKILL.md", content: SKILL_MD },
          { path: "references/notes.md", content: "notes" },
        ],
        source: { kind: "github", owner: "anthropics", repo: "skills" },
        version: "1.0.0",
      },
      opts()
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.replaced).toBe(false);
    expect(res.row.description).toBe("A skill used in unit tests.");

    expect(fs.existsSync(path.join(root, "test-skill", "SKILL.md"))).toBe(true);
    expect(listSkillFiles("test-skill", opts())).toEqual([
      "SKILL.md",
      "references/notes.md",
    ]);

    const rows = await listSkills(opts());
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(true);
  });

  it("rejects invalid names, missing SKILL.md and frontmatter mismatches", async () => {
    const badName = await installSkill(
      { name: "Bad Name", files: [{ path: "SKILL.md", content: SKILL_MD }], source: { kind: "local" } },
      opts()
    );
    expect(badName.ok).toBe(false);

    const noMd = await installSkill(
      { name: "test-skill", files: [{ path: "a.md", content: "x" }], source: { kind: "local" } },
      opts()
    );
    expect(noMd.ok).toBe(false);

    const mismatch = await installSkill(
      { name: "other-name", files: [{ path: "SKILL.md", content: SKILL_MD }], source: { kind: "local" } },
      opts()
    );
    expect(mismatch.ok).toBe(false);
  });

  it("replaces an existing skill in place and keeps enablement", async () => {
    const first = await installSkill(
      { name: "test-skill", files: [{ path: "SKILL.md", content: SKILL_MD }], source: { kind: "local" } },
      opts()
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await setSkillEnabled(first.row.id, false, opts());

    const second = await installSkill(
      {
        name: "test-skill",
        files: [{ path: "SKILL.md", content: SKILL_MD.replace("unit tests", "v2") }],
        source: { kind: "clawhub", slug: "test-skill" },
      },
      opts()
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replaced).toBe(true);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.enabled).toBe(false);
    expect(second.row.description).toContain("v2");
    // Stale files from the previous install are gone.
    expect(listSkillFiles("test-skill", opts())).toEqual(["SKILL.md"]);
  });

  it("toggles enablement and uninstalls", async () => {
    const res = await installSkill(
      { name: "test-skill", files: [{ path: "SKILL.md", content: SKILL_MD }], source: { kind: "local" } },
      opts()
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const disabled = await setSkillEnabled(res.row.id, false, opts());
    expect(disabled?.enabled).toBe(false);
    expect((await listSkills({ ...opts(), enabledOnly: true })).length).toBe(0);

    expect(await uninstallSkill(res.row.id, opts())).toBe(true);
    expect(fs.existsSync(path.join(root, "test-skill"))).toBe(false);
    expect(await getSkillByName("test-skill", opts())).toBeUndefined();
    expect(await uninstallSkill("nope", opts())).toBe(false);
  });

  it("reads the body and bundled files with guards", async () => {
    await installSkill(
      {
        name: "test-skill",
        files: [
          { path: "SKILL.md", content: SKILL_MD },
          { path: "references/notes.md", content: "hello notes" },
        ],
        source: { kind: "local" },
      },
      opts()
    );

    const body = getSkillBody("test-skill", opts());
    expect(body?.body).toContain("Do the test thing.");
    expect(body?.truncated).toBe(false);

    const file = readSkillFile("test-skill", "references/notes.md", opts());
    expect(file).toEqual({ content: "hello notes", truncated: false });

    const escape = readSkillFile("test-skill", "../../etc/passwd", opts());
    expect("error" in escape).toBe(true);

    const missing = readSkillFile("test-skill", "nope.md", opts());
    expect("error" in missing).toBe(true);

    expect(getSkillBody("ghost", opts())).toBeNull();
  });
});
