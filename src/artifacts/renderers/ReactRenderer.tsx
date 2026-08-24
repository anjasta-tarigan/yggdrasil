"use client";

/**
 * React artifacts run inside a sandboxed iframe (opaque origin — same
 * isolation as the HTML renderer). The frame loads Babel standalone and
 * UMD React from a CDN, transpiles the artifact's JSX *inside the frame*
 * and mounts the default-exported component. The host app never evals
 * artifact code in its own JS context.
 *
 * Requires network access for CDN scripts; without it the iframe shows a
 * self-contained error card instead of breaking the panel.
 */

const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups";

function buildRuntimeDocument(code: string): string {
  // Escape the user code so it can be embedded as a JS string literal.
  const embedded = JSON.stringify(code);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://cdn.jsdelivr.net/npm/react@19.1.0/umd/react.production.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/react-dom@19.1.0/umd/react-dom.production.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7.28.4/babel.min.js"><\/script>
<script src="https://cdn.tailwindcss.com/3.4.16"><\/script>
<style>
  html,body{margin:0;padding:16px;background:#fff;color:#0f172a;
    font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}
  .art-error{white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;
    background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;
    border-radius:8px;padding:12px;margin:8px}
</style>
</head>
<body>
<div id="root"></div>
<script>
(function () {
  var root = document.getElementById("root");
  function fail(message) {
    var box = document.createElement("pre");
    box.className = "art-error";
    box.textContent = message;
    document.body.appendChild(box);
  }
  window.addEventListener("error", function (event) {
    if (event.message && !window.__mounted) {
      fail("Runtime error: " + event.message);
    }
  });
  try {
    if (!window.React || !window.ReactDOM || !window.Babel) {
      fail("React runtime CDN unreachable — check network access.");
      return;
    }
    var source = ${embedded};

    // Strip ESM imports; map common libraries to frame globals.
    source = source.replace(
      /import\\s+[^;]*?from\\s*["'](react|react-dom)["'];?/g, ""
    );

    // Exports -> assignments the runner can consume.
    source = source.replace(/export\\s+default\\s+function/, "function");
    source = source.replace(/export\\s+default\\s+/, "window.__EXPORT__ = ");
    source = source.replace(/export\\s+/g, "");

    var compiled = window.Babel.transform(source, {
      presets: [["react", { runtime: "classic" }], "typescript"],
      filename: "artifact.tsx",
    }).code;

    // Evaluate INSIDE this sandboxed origin only.
    new Function("React", "ReactDOM", compiled)(
      window.React, window.ReactDOM
    );

    var Component =
      window.__EXPORT__ ||
      window.App || window.Demo || window.Component || window.default;

    if (typeof Component !== "function" && !(Component && Component.render)) {
      fail("No component found. Export your component with 'export default'.");
      return;
    }

    window.__mounted = true;
    window.ReactDOM.createRoot(root).render(window.React.createElement(Component));
  } catch (error) {
    fail((error && (error.stack || error.message)) || String(error));
  }
})();
<\/script>
</body>
</html>`;
}

export function ReactRenderer({ content }: { content: string }) {
  return (
    <iframe
      className="h-full min-h-0 w-full flex-1 border-0 bg-white"
      sandbox={SANDBOX}
      srcDoc={buildRuntimeDocument(content)}
      title="React artifact preview"
    />
  );
}
