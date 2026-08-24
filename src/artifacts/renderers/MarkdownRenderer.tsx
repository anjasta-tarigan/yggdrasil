"use client";

import { MessageResponse } from "@/components/ai-elements/message";

/** Markdown artifacts reuse the chat's Streamdown pipeline (GFM, math,
 * mermaid), giving artifact documents identical typography to chat. */
export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="px-5 py-4">
      <MessageResponse>{content}</MessageResponse>
    </div>
  );
}
