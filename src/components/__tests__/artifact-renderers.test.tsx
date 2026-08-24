import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactBody,
  buildReactRuntimeDocument,
} from "@/components/artifact-renderers";
import { buildArtifactFromToolOutput } from "@/lib/artifacts";
import type { ChatArtifact } from "@/lib/artifacts";

function artifact(overrides: Partial<ChatArtifact>): ChatArtifact {
  return {
    id: "a1",
    kind: "code",
    title: "Test Artifact",
    description: "test",
    content: "CONTENT",
    filename: "test.txt",
    ...overrides,
  };
}

afterEach(cleanup);

describe("ArtifactBody dispatch", () => {
  it("renders documents through the markdown pipeline", () => {
    render(
      <ArtifactBody artifact={artifact({ kind: "document", content: "# Hello" })} />
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Hello");
  });

  it("renders html artifacts in a sandboxed iframe without allow-same-origin", () => {
    render(<ArtifactBody artifact={artifact({ language: "html" })} />);
    const frame = screen.getByTitle(/HTML artifact/i);
    expect(frame).toHaveAttribute("sandbox");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-popups");
  });

  it("renders svg artifacts via img with a data URL", () => {
    // Route through buildArtifactFromToolOutput — normalizeLanguage must
    // pass "svg" through even though shiki has no SVG grammar; otherwise
    // SvgImage is unreachable in production (falls back to plain pre).
    const fromTool = buildArtifactFromToolOutput("tool-1", {
      title: "Icon",
      kind: "code",
      language: "svg",
      content: "<svg xmlns=\"http://www.w3.org/2000/svg\"/></svg>",
    });
    expect(fromTool?.language).toBe("svg");
    if (!fromTool) throw new Error("svg tool output must build an artifact");
    render(<ArtifactBody artifact={fromTool} />);
    const img = screen.getByAltText(/SVG artifact/i);
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    // No iframe may engage for SVG — scripts must never execute (spec §6).
    expect(screen.queryByTitle(/HTML artifact/i)).toBeNull();
    expect(screen.queryByTitle(/React artifact/i)).toBeNull();
  });

  it("renders jsx artifacts in the react runtime frame", () => {
    render(<ArtifactBody artifact={artifact({ language: "jsx" })} />);
    expect(screen.getByTitle(/React artifact/i)).toBeInTheDocument();
  });

  it("loads CDN scripts before the mount logic that needs them", () => {
    const doc = buildReactRuntimeDocument(
      "export default function App() {\n  return <h1>Hi</h1>;\n}\n"
    );
    // Error-card machinery must exist independent of CDN availability.
    expect(doc).toContain('addEventListener("error"');
    expect(doc).toContain('addEventListener("unhandledrejection"');
    // Bootstrap order: the pinned CDN runtime must precede the
    // transpile/mount block (which reads window.React/Babel and assigns
    // window.__EXPORT__), otherwise the guard always trips offline-first.
    const cdnIndex = doc.indexOf("cdn.jsdelivr.net/npm/react@19.1.0");
    const mountIndex = doc.indexOf("__EXPORT__");
    expect(cdnIndex).toBeGreaterThan(-1);
    expect(mountIndex).toBeGreaterThan(-1);
    expect(cdnIndex).toBeLessThan(mountIndex);
  });

  it("allows unsafe-eval in the React frame CSP but not in the HTML frame CSP", () => {
    // The React mount script runs Babel output through new Function,
    // which every CSP-enforcing browser blocks without 'unsafe-eval' —
    // without it every JSX artifact renders only the error card.
    const reactDoc = buildReactRuntimeDocument(
      "export default function App() {\n  return <h1>Hi</h1>;\n}\n"
    );
    expect(reactDoc).toContain("'unsafe-eval'");
    render(<ArtifactBody artifact={artifact({ language: "jsx" })} />);
    const reactFrameSrcDoc = screen
      .getByTitle(/React artifact/i)
      .getAttribute("srcdoc");
    expect(reactFrameSrcDoc).toContain("'unsafe-eval'");

    // The HTML frame has no eval path — its policy must stay eval-free.
    render(<ArtifactBody artifact={artifact({ language: "html" })} />);
    const htmlFrames = screen.getAllByTitle(/HTML artifact/i);
    expect(htmlFrames).toHaveLength(1);
    const htmlCsp = htmlFrames[0].getAttribute("srcdoc");
    expect(htmlCsp).toContain("Content-Security-Policy");
    expect(htmlCsp).not.toContain("unsafe-eval");
  });

  it("escapes </script> sequences when embedding artifact source", () => {
    const hostile =
      "</script><script>window.__pwned = true;</script><script>";
    const doc = buildReactRuntimeDocument(hostile);
    // Scope to the embedded-source line: the document legitimately
    // contains its own script closers, but none may originate from the
    // artifact source — every "<" there is JSON-escaped to \u003c.
    const sourceLine = doc
      .split("\n")
      .find((line) => line.includes("var source = "));
    expect(sourceLine).toBeDefined();
    expect(sourceLine).not.toContain("</scr" + "ipt>");
    // JSON.stringify escapes only "<"; "/" and ">" stay literal.
    expect(sourceLine).toContain(
      "\\u003c/script>\\u003cscript>window.__pwned"
    );
  });

  it("falls back to plain pre for unknown languages", () => {
    render(<ArtifactBody artifact={artifact({ language: "cobol" })} />);
    // Unknown language -> no iframe, no img; content shown as pre text.
    expect(screen.getByText("CONTENT")).toBeInTheDocument();
  });

  it("falls back to plain pre when language is unrecognized", () => {
    render(
      <ArtifactBody
        artifact={artifact({ language: undefined, content: "PLAIN CONTENT" })}
      />
    );
    // Unrecognized/missing language -> no iframe, no img; raw text in a pre.
    expect(screen.getByText("PLAIN CONTENT")).toBeInTheDocument();
    expect(screen.queryByTitle(/HTML artifact/i)).toBeNull();
    expect(screen.queryByTitle(/React artifact/i)).toBeNull();
    expect(screen.queryByAltText(/SVG artifact/i)).toBeNull();
  });
});
