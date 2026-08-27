import { describe, expect, it } from "vitest";
import {
  isValidSkillName,
  parseSkillMd,
  sanitizeSkillFilePath,
  sanitizeSkillFiles,
  sanitizeSkillSource,
  slugifySkillName,
  splitFrontmatter,
} from "../config";

describe("isValidSkillName", () => {
  it("accepts spec-valid names", () => {
    expect(isValidSkillName("pdf")).toBe(true);
    expect(isValidSkillName("pdf-processing")).toBe(true);
    expect(isValidSkillName("a1-b2")).toBe(true);
  });

  it("rejects invalid names", () => {
    expect(isValidSkillName("")).toBe(false);
    expect(isValidSkillName("PDF")).toBe(false);
    expect(isValidSkillName("-pdf")).toBe(false);
    expect(isValidSkillName("pdf-")).toBe(false);
    expect(isValidSkillName("pdf--processing")).toBe(false);
    expect(isValidSkillName("pdf processing")).toBe(false);
    expect(isValidSkillName("pdf_processing")).toBe(false);
    expect(isValidSkillName("a".repeat(65))).toBe(false);
    expect(isValidSkillName(42)).toBe(false);
  });
});

describe("slugifySkillName", () => {
  it("maps arbitrary labels to spec-valid names", () => {
    expect(slugifySkillName("My Plugin: Cool Skill!")).toBe("my-plugin-cool-skill");
    expect(slugifySkillName("  --Weird__Name-- ")).toBe("weird-name");
  });

  it("returns null when nothing usable remains", () => {
    expect(slugifySkillName("!!!")).toBeNull();
    expect(slugifySkillName("")).toBeNull();
  });
});

describe("sanitizeSkillFilePath", () => {
  it("accepts relative POSIX paths and normalizes them", () => {
    expect(sanitizeSkillFilePath("SKILL.md")).toBe("SKILL.md");
    expect(sanitizeSkillFilePath("references/checklist.md")).toBe(
      "references/checklist.md"
    );
    expect(sanitizeSkillFilePath("./a/./b.md")).toBe("a/b.md");
  });

  it("rejects traversal, absolute and malformed paths", () => {
    expect(sanitizeSkillFilePath("../evil.md")).toBeNull();
    expect(sanitizeSkillFilePath("a/../../evil.md")).toBeNull();
    expect(sanitizeSkillFilePath("/etc/passwd")).toBeNull();
    expect(sanitizeSkillFilePath("C:/windows.md")).toBeNull();
    expect(sanitizeSkillFilePath("a\\b.md")).toBeNull();
    expect(sanitizeSkillFilePath("a\0b.md")).toBeNull();
    expect(sanitizeSkillFilePath("")).toBeNull();
    expect(sanitizeSkillFilePath("x".repeat(600))).toBeNull();
    expect(sanitizeSkillFilePath(7)).toBeNull();
  });
});

describe("sanitizeSkillFiles", () => {
  const skillMd = "---\nname: t\ndescription: d\n---\nbody";

  it("requires SKILL.md at the root", () => {
    const res = sanitizeSkillFiles([{ path: "other.md", content: "x" }]);
    expect(res.ok).toBe(false);
  });

  it("orders SKILL.md first and keeps valid extras", () => {
    const res = sanitizeSkillFiles([
      { path: "references/a.md", content: "a" },
      { path: "SKILL.md", content: skillMd },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.files[0].path).toBe("SKILL.md");
  });

  it("rejects duplicates, bad paths and empty lists", () => {
    expect(sanitizeSkillFiles([]).ok).toBe(false);
    expect(
      sanitizeSkillFiles([
        { path: "SKILL.md", content: skillMd },
        { path: "SKILL.md", content: skillMd },
      ]).ok
    ).toBe(false);
    expect(
      sanitizeSkillFiles([
        { path: "SKILL.md", content: skillMd },
        { path: "../x.md", content: "x" },
      ]).ok
    ).toBe(false);
  });

  it("enforces the file-count cap", () => {
    const files = [{ path: "SKILL.md", content: skillMd }];
    for (let i = 0; i < 100; i++) files.push({ path: `f${i}.md`, content: "x" });
    expect(sanitizeSkillFiles(files).ok).toBe(false);
  });
});

describe("splitFrontmatter", () => {
  it("splits a standard document", () => {
    const { yamlBlock, body } = splitFrontmatter("---\nname: x\n---\nBody text");
    expect(yamlBlock).toBe("name: x");
    expect(body).toBe("Body text");
  });

  it("returns body-only for documents without frontmatter", () => {
    const { yamlBlock, body } = splitFrontmatter("Just markdown");
    expect(yamlBlock).toBeNull();
    expect(body).toBe("Just markdown");
  });

  it("tolerates CRLF and BOM", () => {
    const { yamlBlock } = splitFrontmatter("\uFEFF---\r\nname: x\r\n---\r\nBody");
    expect(yamlBlock).toBe("name: x");
  });
});

describe("parseSkillMd", () => {
  it("parses a minimal valid skill", () => {
    const res = parseSkillMd("---\nname: pdf\ndescription: Handles PDFs.\n---\nDo it.");
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.frontmatter.name).toBe("pdf");
      expect(res.frontmatter.description).toBe("Handles PDFs.");
      expect(res.body.trim()).toBe("Do it.");
      expect(res.unknownFields).toEqual([]);
    }
  });

  it("requires a description", () => {
    const res = parseSkillMd("---\nname: pdf\n---\nbody");
    expect("error" in res).toBe(true);
  });

  it("rejects empty documents and invalid YAML", () => {
    expect("error" in parseSkillMd("")).toBe(true);
    expect("error" in parseSkillMd("---\n: [unclosed\n---\nx")).toBe(true);
  });

  it("rejects non-mapping frontmatter", () => {
    expect("error" in parseSkillMd("---\n- a\n- b\n---\nx")).toBe(true);
  });

  it("validates name rules from frontmatter", () => {
    const res = parseSkillMd("---\nname: Bad_Name\ndescription: d\n---\nx");
    expect("error" in res).toBe(true);
  });

  it("caps description length", () => {
    const res = parseSkillMd(
      `---\ndescription: ${"x".repeat(1025)}\n---\nx`
    );
    expect("error" in res).toBe(true);
  });

  it("tolerates Claude Code extension fields and reports them", () => {
    const res = parseSkillMd(
      "---\nname: t\ndescription: d\ncontext: fork\ndisable-model-invocation: true\n---\nx"
    );
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.unknownFields.sort()).toEqual([
        "context",
        "disable-model-invocation",
      ]);
    }
  });

  it("parses optional spec fields", () => {
    const res = parseSkillMd(
      "---\nname: t\ndescription: d\nlicense: MIT\ncompatibility: needs git\nmetadata:\n  k: v\nallowed-tools: Bash\n---\nx"
    );
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.frontmatter.license).toBe("MIT");
      expect(res.frontmatter.compatibility).toBe("needs git");
      expect(res.frontmatter.metadata).toEqual({ k: "v" });
      expect(res.frontmatter.allowedTools).toBe("Bash");
    }
  });

  it("rejects oversized compatibility and bad metadata shapes", () => {
    expect(
      "error" in
        parseSkillMd(`---\ndescription: d\ncompatibility: ${"x".repeat(501)}\n---\nx`)
    ).toBe(true);
    expect(
      "error" in parseSkillMd("---\ndescription: d\nmetadata: [1,2]\n---\nx")
    ).toBe(true);
  });
});

describe("sanitizeSkillSource", () => {
  it("keeps known kinds and bounded string fields", () => {
    const src = sanitizeSkillSource({
      kind: "clawhub",
      slug: "gifgrep",
      version: "1.0.0",
    });
    expect(src).toEqual({ kind: "clawhub", slug: "gifgrep", version: "1.0.0" });
  });

  it("drops unknown kinds, non-string fields and bad keys", () => {
    expect(sanitizeSkillSource({ kind: "nope" })).toBeNull();
    expect(sanitizeSkillSource(null)).toBeNull();
    const src = sanitizeSkillSource({
      kind: "github",
      owner: "anthropics",
      count: 5,
      "bad-key": "x",
    });
    expect(src).toEqual({ kind: "github", owner: "anthropics" });
  });
});
