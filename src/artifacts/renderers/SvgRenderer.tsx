"use client";

/**
 * SVG artifacts render through an <img> element with a data URL.
 *
 * Security: scripts inside SVG loaded via <img> never execute (image
 * context), so this is safe without extra sanitization while still
 * showing the exact vector graphic. A dark-mode-friendly checkerboard
 * backdrop keeps transparent artwork visible.
 */
export function SvgRenderer({ content }: { content: string }) {
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    content
  )}`;

  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center overflow-auto bg-[repeating-conic-gradient(var(--color-muted)_0%_25%,transparent_0%_50%)] bg-[length:1.5rem_1.5rem] p-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt="SVG artifact preview"
        className="max-h-full max-w-full object-contain"
        src={dataUrl}
      />
    </div>
  );
}
