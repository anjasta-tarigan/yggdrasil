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
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  buildFileTree,
  type ChatArtifact,
  type ChatArtifactFile,
  type FileTreeNode,
} from "@/lib/artifacts";
import {
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileJsonIcon,
  FileTextIcon,
} from "lucide-react";
import type { BundledLanguage } from "shiki";
import { useMemo, useState } from "react";

/** Sandbox WITHOUT allow-same-origin/allow-popups — opaque origin. */
const ARTIFACT_IFRAME_SANDBOX = "allow-scripts allow-forms allow-modals";

/**
 * Defense-in-depth CSP injected into every HTML artifact srcDoc:
 * no remote scripts, inline styles allowed (generated demos style
 * themselves), images/data URIs allowed so demos can embed graphics.
 * No 'unsafe-eval' — this frame has no eval path (the React runtime's
 * Babel transpile uses one; its own document carries it separately).
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
 * The CSP allows 'unsafe-eval': Babel's output runs through new Function.
 * The HTML artifact frame keeps its own stricter policy (inline scripts
 * only, no eval) — the two frames have different execution models.
 *
 * Bootstrap order matters: classic <script> tags execute in document
 * order, so the early inline script only installs the error card
 * machinery; the pinned CDN tags load next; a second inline script
 * AFTER them performs the guard + transpile/mount, when
 * window.React/ReactDOM/Babel are guaranteed present.
 */
export function buildReactRuntimeDocument(code: string): string {
  // Escape "<" so a literal </script> inside the artifact source cannot
  // terminate this inline script early; < decodes to the same
  // character once the browser parses the JS string.
  const embedded = JSON.stringify(code).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https://cdn.jsdelivr.net 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';">
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
  language?: BundledLanguage | "svg";
}) {
  const shikiLang = language && language !== "svg" ? language : undefined;
  return shikiLang ? (
    <CodeBlock
      className="rounded-none border-y-0 border-r-0"
      code={content}
      language={shikiLang}
      showLineNumbers
    />
  ) : (
    <pre className="flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed">
      {content}
    </pre>
  );
}

function getFileIcon(filename: string, language?: string) {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "json") return <FileJsonIcon className="size-4 text-amber-500" />;
  if (ext === "md" || ext === "markdown" || ext === "txt")
    return <FileTextIcon className="size-4 text-blue-400" />;
  if (
    ext === "svg" ||
    ext === "png" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    language === "svg"
  )
    return <FileImageIcon className="size-4 text-purple-400" />;
  if (
    ext === "ts" ||
    ext === "tsx" ||
    ext === "js" ||
    ext === "jsx" ||
    ext === "html" ||
    ext === "css"
  )
    return <FileCodeIcon className="size-4 text-emerald-500" />;
  return <FileIcon className="size-4 text-muted-foreground" />;
}

function renderTreeNodes(nodes: FileTreeNode[]) {
  return nodes.map((node) => {
    if (node.type === "folder") {
      return (
        <FileTreeFolder key={node.path} name={node.name} path={node.path}>
          {renderTreeNodes(node.children)}
        </FileTreeFolder>
      );
    }
    return (
      <FileTreeFile
        icon={getFileIcon(node.name, node.file.language)}
        key={node.path}
        name={node.name}
        path={node.path}
      />
    );
  });
}

function findPreferredDefaultFile(files: ChatArtifactFile[]): ChatArtifactFile | undefined {
  if (files.length === 0) return undefined;
  // Priority entry points: App.tsx/jsx, index.html/tsx/jsx/ts/js, SKILL.md, README.md, main.*
  const priorityPatterns = [
    /^app\.(tsx|jsx|ts|js)$/i,
    /\/app\.(tsx|jsx|ts|js)$/i,
    /^index\.(html|tsx|jsx|ts|js)$/i,
    /\/index\.(html|tsx|jsx|ts|js)$/i,
    /^skill\.md$/i,
    /^readme\.md$/i,
    /^main\.(tsx|jsx|ts|js|py|go|rs)$/i,
  ];

  for (const pattern of priorityPatterns) {
    const match = files.find((f) => pattern.test(f.path) || pattern.test(f.name));
    if (match) return match;
  }

  return files[0];
}

function collectFolderPaths(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.type === "folder") {
      paths.push(node.path);
      paths.push(...collectFolderPaths(node.children));
    }
  }
  return paths;
}

function SingleFileViewer({
  file,
  viewMode = "preview",
}: {
  file: ChatArtifactFile;
  viewMode?: "preview" | "code";
}) {
  if (viewMode === "code") {
    return <CodeView content={file.content} language={file.language} />;
  }

  if (file.kind === "document" || file.language === "markdown") {
    return (
      <div className="px-5 py-4">
        <MessageResponse>{file.content}</MessageResponse>
      </div>
    );
  }

  if (file.language === "svg") {
    return <SvgImage content={file.content} />;
  }

  switch (file.language) {
    case "html":
      return <HtmlFrame content={file.content} />;
    case "jsx":
    case "tsx":
      return <ReactFrame content={file.content} />;
    default:
      return <CodeView content={file.content} language={file.language} />;
  }
}

function MultiFileWorkspace({
  files,
  viewMode = "preview",
}: {
  files: ChatArtifactFile[];
  viewMode?: "preview" | "code";
}) {
  const treeNodes = useMemo(() => buildFileTree(files), [files]);
  const defaultFile = useMemo(() => findPreferredDefaultFile(files), [files]);
  const [selectedFilePath, setSelectedFilePath] = useState<string>(
    () => defaultFile?.path ?? files[0]?.path ?? ""
  );

  const allFolderPaths = useMemo(
    () => new Set(collectFolderPaths(treeNodes)),
    [treeNodes]
  );

  const selectedFile = useMemo(() => {
    return files.find((f) => f.path === selectedFilePath) ?? files[0];
  }, [files, selectedFilePath]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col md:flex-row">
      <div className="w-full shrink-0 border-b bg-muted/20 p-2 md:w-60 md:border-r md:border-b-0">
        <div className="mb-2 px-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
          Explorer
        </div>
        <FileTree
          className="border-0 bg-transparent"
          defaultExpanded={allFolderPaths}
          onSelect={setSelectedFilePath}
          selectedPath={selectedFilePath}
        >
          {renderTreeNodes(treeNodes)}
        </FileTree>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {selectedFile ? (
          <SingleFileViewer file={selectedFile} viewMode={viewMode} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
            Select a file to preview
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Dispatch an artifact to its renderer (spec §3.4 table).
 * Documents go through the chat's markdown pipeline; code artifacts
 * route by language: html/svg/jsx get live previews, others get
 * highlighted source (or plain text for unrecognized languages).
 */
export function ArtifactBody({
  artifact,
  viewMode = "preview",
}: {
  artifact: ChatArtifact;
  viewMode?: "preview" | "code";
}) {
  if (artifact.files && artifact.files.length > 0) {
    return <MultiFileWorkspace files={artifact.files} viewMode={viewMode} />;
  }

  if (viewMode === "code") {
    return (
      <CodeView content={artifact.content} language={artifact.language} />
    );
  }

  if (artifact.kind === "document") {
    return (
      <div className="px-5 py-4">
        <MessageResponse>{artifact.content}</MessageResponse>
      </div>
    );
  }

  // svg has no shiki grammar; handled as its own renderer route.
  if (artifact.language === "svg") {
    return <SvgImage content={artifact.content} />;
  }
  switch (artifact.language) {
    case "html":
      return <HtmlFrame content={artifact.content} />;
    case "jsx":
    case "tsx":
      return <ReactFrame content={artifact.content} />;
    default:
      return (
        <CodeView content={artifact.content} language={artifact.language} />
      );
  }
}
