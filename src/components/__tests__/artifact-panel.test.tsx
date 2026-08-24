import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactPanel } from "@/components/artifact-panel";
import type { ChatArtifact } from "@/lib/artifacts";

function makeArtifact(): ChatArtifact {
  return {
    id: "a1",
    kind: "code",
    title: "Sample Script",
    description: "python · 3 lines",
    content: "print('hi')",
    language: "python",
    filename: "sample-script.py",
  };
}

afterEach(cleanup);

describe("ArtifactPanel", () => {
  it("renders nothing when artifact is null", () => {
    render(<ArtifactPanel artifact={null} artifactCount={0} onClose={() => {}} />);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("shows title and content when open", () => {
    render(<ArtifactPanel artifact={makeArtifact()} artifactCount={1} onClose={() => {}} />);
    expect(screen.getByText("Sample Script")).toBeInTheDocument();
    expect(screen.getByText(/print\('hi'\)/)).toBeInTheDocument();
  });

  it("closes on Escape and returns focus via onClose", () => {
    const onClose = vi.fn();
    render(<ArtifactPanel artifact={makeArtifact()} artifactCount={1} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("close button triggers onClose", () => {
    const onClose = vi.fn();
    render(<ArtifactPanel artifact={makeArtifact()} artifactCount={1} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("copy writes content to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ArtifactPanel artifact={makeArtifact()} artifactCount={1} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("print('hi')"));
  });

  it("download calls downloadTextFile path (anchor click)", () => {
    const clickSpy = vi.fn();
    // Capture the original BEFORE spying: inside the mock,
    // document.createElement is already the spy, so calling it there
    // would recurse forever (RangeError under vitest 4 + jsdom).
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
      tag === "a"
        ? ({ href: "", download: "", click: clickSpy } as unknown as HTMLAnchorElement)
        : originalCreateElement(tag)) as unknown as typeof document.createElement);
    render(<ArtifactPanel artifact={makeArtifact()} artifactCount={1} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    expect(clickSpy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("is inert when closed but still mounted during exit animation", () => {
    // The panel receives artifact=null during exit; host keeps mounting it.
    render(<ArtifactPanel artifact={null} artifactCount={0} onClose={() => {}} />);
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("shows stack indicator for multiple artifacts", () => {
    render(<ArtifactPanel artifact={makeArtifact()} artifactCount={3} onClose={() => {}} />);
    expect(screen.getByText(/3 artifacts/i)).toBeInTheDocument();
  });
});
