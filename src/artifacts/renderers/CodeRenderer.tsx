"use client";

import { CodeBlock } from "@/components/ai-elements/code-block";
import { bundledLanguages, type BundledLanguage } from "shiki";

/**
 * Plain code files: syntax-highlighted, read-only shiki view. Languages
 * shiki does not bundle fall back to a plain pre block.
 */
export function CodeRenderer({
  content,
  language,
}: {
  content: string;
  language?: string;
}) {
  const highlighted =
    language && language in bundledLanguages
      ? (language as BundledLanguage)
      : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {highlighted ? (
        <CodeBlock
          className="min-h-0 flex-1 rounded-none border-y-0 border-r-0"
          code={content}
          language={highlighted}
          showLineNumbers
        />
      ) : (
        <pre className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
          {content}
        </pre>
      )}
    </div>
  );
}
