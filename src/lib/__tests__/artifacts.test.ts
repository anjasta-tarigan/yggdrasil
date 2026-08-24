import { describe, expect, it } from "vitest";
import {
  buildArtifactFilename,
  extensionFor,
  slugify,
} from "@/lib/artifacts";

describe("slugify", () => {
  it("lowercases and dash-joins words", () => {
    expect(slugify("Fibonacci Generator in Rust", "artifact")).toBe(
      "fibonacci-generator-in-rust"
    );
  });

  it("strips path separators so titles cannot traverse directories", () => {
    expect(slugify("../../etc/passwd", "artifact")).not.toContain("/");
    expect(slugify("..\\..\\windows\\system32", "artifact")).not.toContain(
      "\\"
    );
    expect(slugify("../../etc/passwd", "artifact")).toBe("etc-passwd");
  });

  it("collapses invalid-character runs into single dashes", () => {
    expect(slugify("A  B///C???D", "artifact")).toBe("a-b-c-d");
  });

  it("falls back when every character is stripped", () => {
    expect(slugify("🎉🎊", "artifact")).toBe("artifact");
    expect(slugify("", "artifact")).toBe("artifact");
  });

  it("caps length at 48 characters", () => {
    expect(slugify("a".repeat(200), "artifact").length).toBeLessThanOrEqual(
      48
    );
  });
});

describe("extensionFor", () => {
  it("documents always get md", () => {
    expect(extensionFor("document", undefined)).toBe("md");
    expect(extensionFor("document", "python")).toBe("md");
  });

  it("maps common code languages per spec table", () => {
    expect(extensionFor("code", "typescript")).toBe("ts");
    expect(extensionFor("code", "ts")).toBe("ts");
    expect(extensionFor("code", "tsx")).toBe("tsx");
    expect(extensionFor("code", "javascript")).toBe("jsx");
    expect(extensionFor("code", "jsx")).toBe("jsx");
    expect(extensionFor("code", "python")).toBe("py");
    expect(extensionFor("code", "rust")).toBe("rs");
    expect(extensionFor("code", "go")).toBe("go");
    expect(extensionFor("code", "json")).toBe("json");
    expect(extensionFor("code", "bash")).toBe("sh");
    expect(extensionFor("code", "html")).toBe("html");
    expect(extensionFor("code", "css")).toBe("css");
    expect(extensionFor("code", "scss")).toBe("scss");
  });

  it("uses the raw language token for other values", () => {
    expect(extensionFor("code", "kotlin")).toBe("kotlin");
    expect(extensionFor("code", "swift")).toBe("swift");
  });

  it("normalizes case and strips info-string suffixes", () => {
    expect(extensionFor("code", "TypeScript")).toBe("ts");
    expect(extensionFor("code", "python title=x")).toBe("py");
  });

  it("falls back to txt for unknown or missing languages", () => {
    expect(extensionFor("code", undefined)).toBe("txt");
    expect(extensionFor("code", "")).toBe("txt");
    expect(extensionFor("code", "not-real!")).toBe("txt");
  });
});

describe("buildArtifactFilename", () => {
  it("combines slugified title with mapped extension", () => {
    expect(
      buildArtifactFilename({
        kind: "code",
        language: "python",
        title: "My Script!",
      })
    ).toBe("my-script.py");
  });

  it("uses artifact fallback when the title slugs empty", () => {
    expect(buildArtifactFilename({ kind: "document", title: "🎉🎊" })).toBe(
      "artifact.md"
    );
  });
});
