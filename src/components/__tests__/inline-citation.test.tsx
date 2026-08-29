import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Sources,
  SourcesTrigger,
  SourcesContent,
  Source,
} from "@/components/ai-elements/sources";
import {
  InlineCitation,
  InlineCitationCard,
  InlineCitationCardTrigger,
} from "@/components/ai-elements/inline-citation";

describe("Sources & Citations Components", () => {
  it("renders collapsible Sources tray with correct count and links", () => {
    render(
      <Sources defaultOpen>
        <SourcesTrigger count={2} />
        <SourcesContent>
          <Source href="https://example.com/docs" title="Example Docs" />
          <Source href="https://ai-sdk.dev" title="AI SDK Docs" />
        </SourcesContent>
      </Sources>
    );

    expect(screen.getByText(/Used 2 sources/i)).toBeDefined();
    expect(screen.getByText("Example Docs")).toBeDefined();
    expect(screen.getByText("AI SDK Docs")).toBeDefined();
  });

  it("renders inline citation trigger with domain name badge", () => {
    render(
      <InlineCitation>
        <InlineCitationCard>
          <InlineCitationCardTrigger sources={["https://ai-sdk.dev/docs/agents"]} />
        </InlineCitationCard>
      </InlineCitation>
    );

    expect(screen.getByText(/ai-sdk.dev/i)).toBeDefined();
  });
});
