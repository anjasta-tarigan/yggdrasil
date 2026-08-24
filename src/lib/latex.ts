/**
 * LaTeX delimiter normalization for AI responses.
 *
 * The markdown pipeline (remark-math -> rehype-katex) only recognizes
 * `$...$` and `$$...$$` delimiters. Models frequently emit LaTeX-style
 * delimiters too (`\(...\)` and `\[...\]`), which would otherwise render
 * as raw text. This converts them to dollar delimiters outside of code
 * blocks so KaTeX can render them.
 */

const CODE_SEGMENT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g;

export function normalizeLatexDelimiters(markdown: string): string {
  if (!markdown.includes("\\(") && !markdown.includes("\\[")) {
    return markdown;
  }

  // Split into code and non-code segments (odd indices are code) so we
  // never rewrite delimiters inside fenced or inline code.
  return markdown
    .split(CODE_SEGMENT)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment
        .replace(/\\\[([\s\S]*?)\\\]/g, (_match, inner: string) => `$$${inner}$$`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_match, inner: string) => `$${inner}$`);
    })
    .join("");
}
