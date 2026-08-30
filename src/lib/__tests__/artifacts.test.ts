import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import {
  buildArtifactFilename,
  buildArtifactFromToolOutput,
  buildFileTree,
  collectArtifacts,
  extensionFor,
  latestArtifact,
  slugify,
  type ChatArtifactFile,
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

describe("buildFileTree", () => {
  it("converts flat file paths into nested tree nodes", () => {
    const files: ChatArtifactFile[] = [
      { path: "package.json", name: "package.json", content: "{}", kind: "code" },
      { path: "src/App.tsx", name: "App.tsx", content: "export default () => null", kind: "code", language: "tsx" },
      { path: "src/components/Button.tsx", name: "Button.tsx", content: "export const Button = () => null", kind: "code", language: "tsx" },
      { path: "README.md", name: "README.md", content: "# Hello", kind: "document" },
    ];

    const tree = buildFileTree(files);
    expect(tree).toBeDefined();
    // Root should contain package.json, src folder, and README.md
    const srcFolder = tree.find((n) => n.type === "folder" && n.name === "src");
    expect(srcFolder).toBeDefined();
    if (srcFolder && srcFolder.type === "folder") {
      expect(srcFolder.children.find((c) => c.name === "App.tsx")).toBeDefined();
      const compFolder = srcFolder.children.find((c) => c.type === "folder" && c.name === "components");
      expect(compFolder).toBeDefined();
      if (compFolder && compFolder.type === "folder") {
        expect(compFolder.children.find((c) => c.name === "Button.tsx")).toBeDefined();
      }
    }
  });

  it("sorts folders before files and alphabetically within groups", () => {
    const files: ChatArtifactFile[] = [
      { path: "z.txt", name: "z.txt", content: "", kind: "document" },
      { path: "a.txt", name: "a.txt", content: "", kind: "document" },
      { path: "b/inner.txt", name: "inner.txt", content: "", kind: "document" },
      { path: "a/inner.txt", name: "inner.txt", content: "", kind: "document" },
    ];

    const tree = buildFileTree(files);
    expect(tree.map((n) => n.name)).toEqual(["a", "b", "a.txt", "z.txt"]);
  });
});

describe("buildArtifactFromToolOutput multi-file handling", () => {
  it("correctly parses multi-file project outputs", () => {
    const output = {
      title: "Multi-file Project",
      kind: "project" as const,
      files: [
        { path: "src/index.ts", content: "console.log(1);", language: "typescript" },
        { path: "README.md", content: "# Project docs" },
      ],
    };

    const artifact = buildArtifactFromToolOutput("call-multi", output);
    expect(artifact).toBeDefined();
    expect(artifact?.kind).toBe("project");
    expect(artifact?.files).toHaveLength(2);
    expect(artifact?.files?.[0]).toEqual({
      path: "src/index.ts",
      name: "index.ts",
      content: "console.log(1);",
      language: "typescript",
      kind: "code",
    });
    expect(artifact?.files?.[1]).toEqual({
      path: "README.md",
      name: "README.md",
      content: "# Project docs",
      language: "markdown",
      kind: "document",
    });
    expect(artifact?.description).toBe("2 files");
    expect(artifact?.content).toBe("console.log(1);");
  });

  it("handles project without files array gracefully if content is provided", () => {
    const output = {
      title: "Single File Project",
      kind: "project" as const,
      content: "const a = 1;",
      language: "typescript",
    };

    const artifact = buildArtifactFromToolOutput("call-single-proj", output);
    expect(artifact).toBeDefined();
    expect(artifact?.kind).toBe("project");
    expect(artifact?.files).toHaveLength(1);
    expect(artifact?.files?.[0].name).toBe("Single File Project");
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
  it("extracts artifact_publish outputs into ChatArtifacts", () => {
    const messages = [
      msgWithToolPart({
        type: "tool-artifact_publish",
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

  it("still extracts legacy create_artifact parts from old conversations", () => {
    const messages = [
      msgWithToolPart({
        type: "tool-create_artifact",
        toolCallId: "call-legacy",
        state: "output-available",
        input: {},
        output: validOutput(),
      }),
    ];
    const result = collectArtifacts(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "call-legacy", title: "Demo Page" });
  });

  it("ignores non-output states", () => {
    const messages = [
      msgWithToolPart({
        type: "tool-artifact_publish",
        toolCallId: "call-2",
        state: "input-streaming",
        input: {},
      }),
      msgWithToolPart({
        type: "tool-artifact_publish",
        toolCallId: "call-3",
        state: "input-available",
        input: {},
      }),
      msgWithToolPart({
        type: "tool-artifact_publish",
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
          type: "tool-artifact_publish",
          toolCallId: "call-bad",
          state: "output-available",
          input: {},
          output: { title: 42, kind: "nope", content: "" },
        }),
        msgWithToolPart({
          type: "tool-artifact_publish",
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
        type: "tool-artifact_publish",
        toolCallId: "call-old",
        state: "output-available",
        input: {},
        output: { title: "First Doc", kind: "document", content: "# hi" },
      }),
    ];
    const newer = [
      msgWithToolPart({
        type: "tool-artifact_publish",
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
        type: "tool-artifact_publish",
        toolCallId: "call-a",
        state: "output-available",
        input: {},
        output: { title: "A", kind: "document", content: "a" },
      }),
      msgWithToolPart({
        type: "tool-artifact_publish",
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

import { downloadTextFile } from "@/lib/artifacts";

describe("downloadTextFile", () => {
  it("creates a blob URL, clicks an anchor, then revokes asynchronously", () => {
    vi.useFakeTimers();
    const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clickSpy = vi.fn();
    const anchorSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation(((tag: string) => {
        if (tag === "a") {
          return {
            set href(_: string) {},
            set download(_: string) {},
            click: clickSpy,
          } as unknown as HTMLAnchorElement;
        }
        return document.createElement(tag);
      }) as unknown as typeof document.createElement);
    try {
      downloadTextFile("x.txt", "hi");
      expect(clickSpy).toHaveBeenCalled();
      // Revocation is deferred so the browser can start the download.
      expect(revokeSpy).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revokeSpy).toHaveBeenCalledWith("blob:x");
    } finally {
      vi.useRealTimers();
      anchorSpy.mockRestore();
      createSpy.mockRestore();
      revokeSpy.mockRestore();
    }
  });
});
