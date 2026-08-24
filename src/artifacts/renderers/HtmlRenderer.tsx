"use client";

/**
 * HTML artifacts render in a sandboxed iframe.
 *
 * Security: `sandbox` deliberately OMITS allow-same-origin, so the frame
 * gets an opaque origin and cannot read the parent app's cookies,
 * localStorage, sessionStorage or DOM, and cannot make same-origin
 * requests. Scripts/forms/popups/modals are allowed inside the frame so
 * demos stay interactive. Content is injected via srcDoc — never
 * dangerouslySetInnerHTML into the app DOM.
 */

const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups";

export function HtmlRenderer({ content }: { content: string }) {
  return (
    <iframe
      className="h-full min-h-0 w-full flex-1 border-0 bg-white"
      sandbox={SANDBOX}
      srcDoc={content}
      title="HTML artifact preview"
    />
  );
}

export { SANDBOX as ARTIFACT_IFRAME_SANDBOX };
