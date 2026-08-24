import { cleanup, render, screen } from "@testing-library/react";
import type { BundledLanguage } from "shiki";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactBody,
  buildReactRuntimeDocument,
} from "@/components/artifact-renderers";
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
    // "svg" has no shiki grammar, so cast: the renderer must still route it.
    render(
      <ArtifactBody
        artifact={artifact({ language: "svg" as BundledLanguage })}
      />
    );
    const img = screen.getByAltText(/SVG artifact/i);
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
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
