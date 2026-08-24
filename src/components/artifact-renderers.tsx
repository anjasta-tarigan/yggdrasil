"use client";

/**
 * Type-specific renderers for artifact content (spec §3.4).
 *
 * Security posture (spec §6):
 * - HTML/React run in sandboxed iframes with opaque origin (no
 *   allow-same-origin, no allow-popups); the host app never evals
 *   artifact code — Babel transpiles inside the frame.
 * - SVG renders via <img>, where scripts never execute.
 * - CSP meta tags restrict in-frame script/network origins.
 */

import { CodeBlock } from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message";
import type { ChatArtifact } from "@/lib/artifacts";
import type { BundledLanguage } from "shiki";

/** Sandbox WITHOUT allow-same-origin/allow-popups — opaque origin. */
const ARTIFACT_IFRAME_SANDBOX = "allow-scripts allow-forms allow-modals";

/**
 * Defense-in-depth CSP injected into every HTML artifact srcDoc:
 * no remote scripts, inline styles allowed (generated demos style
 * themselves), images/data URIs allowed so demos can embed graphics.
 */
const HTML_CSP_META =
  '<meta http-equiv="Content-Security-Policy" ' +
  'content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:;">';

function HtmlFrame({ content }: { content: string }) {
  return (
    <iframe
      className="h-full min-h-0 w-full flex-1 border-0 bg-white"
      sandbox={ARTIFACT_IFRAME_SANDBOX}
      srcDoc={`<!doctype html><html><head><meta charset="utf-8">${HTML_CSP_META}</head><body>${content}</body></html>`}
      title="HTML artifact preview"
    />
  );
}

function SvgImage({ content }: { content: string }) {
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center overflow-auto p-6">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt="SVG artifact preview"
        className="max-h-full max-w-full object-contain"
        src={dataUrl}
      />
    </div>
  );
}

/**
 * Builds the self-contained runtime document for React artifacts:
 * pinned CDN versions, CSP meta, inline error handling that does not
 * depend on the CDN having loaded, error+unhandledrejection handlers.
 *
 * Bootstrap order matters: classic <script> tags execute in document
 * order, so the early inline script only installs the error card
 * machinery; the pinned CDN tags load next; a second inline script
 * AFTER them performs the guard + transpile/mount, when
 * window.React/ReactDOM/Babel are guaranteed present.
 */
export function buildReactRuntimeDocument(code: string): string {
  const embedded = JSON.stringify(code);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
  html,body{margin:0;padding:16px;background:#fff;color:#0f172a;font-family:ui-sans-serif,system-ui,sans-serif}
  .art-error{white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:12px;margin:8px}
</style>
<script>
(function () {
  function fail(message) {
    var box = document.createElement("pre");
    box.className = "art-error";
    box.textContent = message;
    // Append on DOMContentLoaded — the head script runs before body exists.
    function mount() {
      document.body.appendChild(box);
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mount);
    } else {
      mount();
    }
  }
  window.__artFail = fail;
  window.addEventListener("error", function (event) {
    fail((event.error && event.error.stack) || event.message || String(event.error));
  });
  window.addEventListener("unhandledrejection", function (event) {
    fail("Unhandled rejection: " + ((event.reason && (event.reason.stack || event.reason.message)) || String(event.reason)));
  });
})();
<\/script>
</head>
<body>
<div id="root"></div>
<script src="https://cdn.jsdelivr.net/npm/react@19.1.0/umd/react.production.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/react-dom@19.1.0/umd/react-dom.production.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7.28.4/babel.min.js"><\/script>
<script>
(function () {
  var root = document.getElementById("root");
  var fail = window.__artFail;
  if (!window.React || !window.ReactDOM || !window.Babel) {
    fail("React runtime CDN unreachable — check network access.");
    return;
  }
  try {
    var source = ${embedded};
    source = source.replace(/import\\s[^;]*?from\\s*['"](react|react-dom)['"];?/g, "");
    source = source.replace(/export\\s+default\\s+function/, "function");
    source = source.replace(/export\\s+default\\s+/, "window.__EXPORT__ = ");
    source = source.replace(/^export\\s+/gm, "");
    var compiled = window.Babel.transform(source, {
      presets: [["react", { runtime: "classic" }], "typescript"],
      filename: "artifact.tsx",
    }).code;
    new Function("React", "ReactDOM", compiled)(window.React, window.ReactDOM);
    var Component = window.__EXPORT__ || window.App || window.Demo || window.Component || window.default;
    if (typeof Component !== "function") {
      fail("No component found. Export your component with 'export default'.");
      return;
    }
    window.ReactDOM.createRoot(root).render(window.React.createElement(Component));
  } catch (error) {
    fail((error && (error.stack || error.message)) || String(error));
  }
})();
<\/script>
</body>
</html>`;
}

function ReactFrame({ content }: { content: string }) {
  return (
    <iframe
      className="h-full min-h-0 w-full flex-1 border-0 bg-white"
      sandbox={ARTIFACT_IFRAME_SANDBOX}
      srcDoc={buildReactRuntimeDocument(content)}
      title="React artifact preview"
    />
  );
}

function CodeView({
  content,
  language,
}: {
  content: string;
  language?: BundledLanguage;
}) {
  return language ? (
    <CodeBlock
      className="rounded-none border-y-0 border-r-0"
      code={content}
      language={language}
      showLineNumbers
    />
  ) : (
    <pre className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
      {content}
    </pre>
  );
}

/**
 * Dispatch an artifact to its renderer (spec §3.4 table).
 * Documents go through the chat's markdown pipeline; code artifacts
 * route by language: html/svg/jsx get live previews, others get
 * highlighted source (or plain text for unrecognized languages).
 */
export function ArtifactBody({ artifact }: { artifact: ChatArtifact }) {
  if (artifact.kind === "document") {
    return (
      <div className="px-5 py-4">
        <MessageResponse>{artifact.content}</MessageResponse>
      </div>
    );
  }

  // "svg" has no shiki grammar, so BundledLanguage excludes it; widen the
  // discriminant so the spec §3.4 SVG route stays expressible (spec §6:
  // SVG must render via <img>, where scripts never execute).
  switch (artifact.language as string) {
    case "html":
      return <HtmlFrame content={artifact.content} />;
    case "svg":
      return <SvgImage content={artifact.content} />;
    case "jsx":
    case "tsx":
      return <ReactFrame content={artifact.content} />;
    default:
      return (
        <CodeView content={artifact.content} language={artifact.language} />
      );
  }
}
