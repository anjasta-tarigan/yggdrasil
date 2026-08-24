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
  it("renders inert empty shell when closed", () => {
    render(
      <ArtifactPanel
        artifact={null}
        artifactCount={0}
        onClose={() => {}}
        open={false}
      />
    );
    // aria-hidden/inert hide the aside from the a11y tree; hidden:true is
    // required for getByRole to see it at all.
    expect(screen.getByRole("complementary", { hidden: true })).toHaveAttribute(
      "aria-hidden",
      "true"
    );
  });

  it("shows title and content when open", () => {
    render(
      <ArtifactPanel
        artifact={makeArtifact()}
        artifactCount={1}
        onClose={() => {}}
        open={true}
      />
    );
    expect(screen.getByText("Sample Script")).toBeInTheDocument();
    expect(screen.getByText(/print\('hi'\)/)).toBeInTheDocument();
  });

  it("does not close on Escape when closed", () => {
    const onClose = vi.fn();
    render(
      <ArtifactPanel
        artifact={makeArtifact()}
        artifactCount={1}
        onClose={onClose}
        open={false}
      />
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape and returns focus via onClose", () => {
    const onClose = vi.fn();
    render(
      <ArtifactPanel
        artifact={makeArtifact()}
        artifactCount={1}
        onClose={onClose}
        open={true}
      />
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("close button triggers onClose", () => {
    const onClose = vi.fn();
    render(
      <ArtifactPanel
        artifact={makeArtifact()}
        artifactCount={1}
        onClose={onClose}
        open={true}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("copy writes content to clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <ArtifactPanel
        artifact={makeArtifact()}
        artifactCount={1}
        onClose={() => {}}
        open={true}
      />
    );
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
    render(
      <ArtifactPanel
        artifact={makeArtifact()}
        artifactCount={1}
        onClose={() => {}}
        open={true}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    expect(clickSpy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("is inert while holding content during the exit animation", () => {
    // Exit hold: the host keeps the last artifact mounted, but `open` has
    // already gone false — content shows through the slide-out, inertly.
    render(
      <ArtifactPanel
        artifact={makeArtifact()}
        artifactCount={1}
        onClose={() => {}}
        open={false}
      />
    );
    expect(
      screen.getByRole("complementary", { hidden: true })
    ).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("renders empty shell without frame title when open with no artifact", () => {
    // Mid-slide-in: open is already true but the artifact has not landed yet.
    render(
      <ArtifactPanel
        artifact={null}
        artifactCount={0}
        onClose={() => {}}
        open={true}
      />
    );
    expect(
      screen.getByRole("complementary", { hidden: true })
    ).toHaveAttribute("aria-hidden", "false");
    expect(screen.queryByText("Sample Script")).toBeNull();
  });

  it("shows stack indicator for multiple artifacts", () => {
    render(
      <ArtifactPanel
        artifact={makeArtifact()}
        artifactCount={3}
        onClose={() => {}}
        open={true}
      />
    );
    expect(screen.getByText(/3 artifacts/i)).toBeInTheDocument();
  });

  it("defaults first desktop open to DEFAULT_DESKTOP_WIDTH, not full viewport", () => {
    // No stored width (fresh browser): the panel must open at a sane
    // default so the chat column never collapses to zero on desktop.
    const removeItemSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {});
    window.localStorage.removeItem("artifact-panel-width-desktop");
    // jsdom has no matchMedia; stub desktop so the width style applies.
    const mqlStub = {
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue(mqlStub) as unknown as (
        query: string
      ) => MediaQueryList
    );
    try {
      render(
        <ArtifactPanel
          artifact={makeArtifact()}
          artifactCount={1}
          onClose={() => {}}
          open={true}
        />
      );
      const aside = screen.getByRole("complementary", { hidden: true });
      expect(aside.getAttribute("style")).toContain("520px");
    } finally {
      vi.unstubAllGlobals();
      removeItemSpy.mockRestore();
    }
  });
});
