import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import {
  buildArtifactFilename,
  collectArtifacts,
  extensionFor,
  latestArtifact,
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

/** Minimal assistant message carrying one raw tool part. */
function msgWithToolPart(part: Record<string, unknown>): UIMessage {
  return {
    id: "m-" + Math.random().toString(36).slice(2),
    role: "assistant",
    parts: [part as unknown as UIMessage["parts"][number]],
  };
}

function validOutput() {
  return {
    title: "Demo Page",
    kind: "code" as const,
    language: "html",
    content: "<p>hello</p>",
  };
}

describe("collectArtifacts", () => {
  it("extracts create_artifact outputs into ChatArtifacts", () => {
    const messages = [
      msgWithToolPart({
        type: "tool-create_artifact",
        toolCallId: "call-1",
        state: "output-available",
        input: {},
        output: validOutput(),
      }),
    ];
    const result = collectArtifacts(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "call-1",
      title: "Demo Page",
      kind: "code",
      content: "<p>hello</p>",
      filename: "demo-page.html",
      description: expect.stringContaining("lines"),
    });
  });

  it("ignores other tools entirely", () => {
    const messages = [
      msgWithToolPart({
        type: "tool-web_search",
        toolCallId: "call-x",
        state: "output-available",
        input: { query: "q" },
        output: { results: [] },
      }),
    ];
    expect(collectArtifacts(messages)).toHaveLength(0);
  });

  it("ignores non-output states", () => {
    const messages = [
      msgWithToolPart({
        type: "tool-create_artifact",
        toolCallId: "call-2",
        state: "input-streaming",
        input: {},
      }),
      msgWithToolPart({
        type: "tool-create_artifact",
        toolCallId: "call-3",
        state: "input-available",
        input: {},
      }),
      msgWithToolPart({
        type: "tool-create_artifact",
        toolCallId: "call-4",
        state: "output-error",
        input: {},
        errorText: "boom",
      }),
    ];
    expect(collectArtifacts(messages)).toHaveLength(0);
  });

  it("returns empty for empty or user-only conversations", () => {
    expect(collectArtifacts([])).toHaveLength(0);
    expect(
      collectArtifacts([
        { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ])
    ).toHaveLength(0);
  });

  it("skips malformed outputs but keeps well-formed siblings, warning once per bad id", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const messages = [
        msgWithToolPart({
          type: "tool-create_artifact",
          toolCallId: "call-bad",
          state: "output-available",
          input: {},
          output: { title: 42, kind: "nope", content: "" },
        }),
        msgWithToolPart({
          type: "tool-create_artifact",
          toolCallId: "call-good",
          state: "output-available",
          input: {},
          output: validOutput(),
        }),
      ];
      const result = collectArtifacts(messages);
      expect(result.map((a) => a.id)).toEqual(["call-good"]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("call-bad"),
        expect.anything()
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("orders results oldest-first across messages", () => {
    const older = [
      msgWithToolPart({
        type: "tool-create_artifact",
        toolCallId: "call-old",
        state: "output-available",
        input: {},
        output: { title: "First Doc", kind: "document", content: "# hi" },
      }),
    ];
    const newer = [
      msgWithToolPart({
        type: "tool-create_artifact",
        toolCallId: "call-new",
        state: "output-available",
        input: {},
        output: { title: "Second Doc", kind: "document", content: "# bye" },
      }),
    ];
    expect(collectArtifacts([...older, ...newer]).map((a) => a.id)).toEqual([
      "call-old",
      "call-new",
    ]);
  });
});

describe("latestArtifact", () => {
  it("returns the newest artifact", () => {
    const messages = [
      msgWithToolPart({
        type: "tool-create_artifact",
        toolCallId: "call-a",
        state: "output-available",
        input: {},
        output: { title: "A", kind: "document", content: "a" },
      }),
      msgWithToolPart({
        type: "tool-create_artifact",
        toolCallId: "call-b",
        state: "output-available",
        input: {},
        output: { title: "B", kind: "document", content: "b" },
      }),
    ];
    expect(latestArtifact(messages)?.id).toBe("call-b");
  });

  it("returns null when there are no artifacts", () => {
    expect(latestArtifact([])).toBeNull();
  });
});
