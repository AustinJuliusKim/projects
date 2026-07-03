/**
 * Shows the currently open file. When prevContent differs from content,
 * renders a line diff (add=green, del=red) instead of plain content.
 *
 * Preview tab (html/markdown files): rendered entirely inside a
 * `sandbox="allow-scripts"` iframe. That sandbox iframe IS the sanitization
 * boundary for this feature — that's why there's no DOMPurify pass on the
 * HTML/markdown output before it's rendered. This invariant breaks if:
 *   - `allow-same-origin` is ever added to the sandbox attribute (it would
 *     let framed content reach the parent document/cookies/storage), or
 *   - preview content is ever rendered outside the iframe (e.g. dangerously
 *     set into the parent DOM).
 * A future Content-Security-Policy on this app must allow `frame-src 'self'`
 * for the preview iframe (srcDoc inherits the parent origin's CSP frame-src)
 * to keep working.
 */

import { useEffect, useState } from "react";
import { diff } from "../lib/diff.js";
import { fileKind, rewriteRefs } from "../lib/previewRefs.js";
import { renderMarkdownDoc } from "../lib/markdownPreview.js";

/**
 * @param {{lines: import("../lib/diff.js").DiffLine[]}} props
 */
function DiffViewer({ lines }) {
  return (
    <pre className="diff-viewer" data-testid="diff-viewer">
      {lines.map((line, i) => (
        <div className={`diff-line diff-line-${line.type}`} key={i}>
          <span className="diff-marker">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</span>
          <code>{line.line}</code>
        </div>
      ))}
    </pre>
  );
}

/**
 * @param {{path: string|null, file: import("../lib/virtualFs.js").VFile|undefined, files: import("../lib/virtualFs.js").VFiles}} props
 */
export default function FileViewer({ path, file, files }) {
  const changed = !!file && file.prevContent !== undefined && file.prevContent !== file.content;
  const kind = path ? fileKind(path) : null;

  // Reset to source|diff on every path change — preview is never the
  // default, so the three existing diff-viewer e2e assertions keep passing.
  const [mode, setMode] = useState(changed ? "diff" : "source");
  useEffect(() => {
    setMode(changed ? "diff" : "source");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  if (!path || !file) {
    return (
      <div className="file-viewer file-viewer-empty" data-testid="file-viewer">
        No file open
      </div>
    );
  }

  const showTabs = changed || !!kind;

  return (
    <div className="file-viewer" data-testid="file-viewer">
      <div className="file-viewer-path">{path}</div>
      {showTabs && (
        <div className="viewer-tabs">
          <button
            type="button"
            className={`viewer-tab${mode === "source" ? " viewer-tab-active" : ""}`}
            onClick={() => setMode("source")}
          >
            Source
          </button>
          {changed && (
            <button
              type="button"
              className={`viewer-tab${mode === "diff" ? " viewer-tab-active" : ""}`}
              onClick={() => setMode("diff")}
            >
              Diff
            </button>
          )}
          {kind && (
            <button
              type="button"
              data-testid="preview-toggle"
              className={`viewer-tab${mode === "preview" ? " viewer-tab-active" : ""}`}
              onClick={() => setMode("preview")}
            >
              Preview
            </button>
          )}
        </div>
      )}
      {mode === "diff" && changed && <DiffViewer lines={diff(file.prevContent, file.content)} />}
      {mode === "preview" && kind === "html" && (
        <iframe
          className="preview-frame"
          data-testid="preview-frame"
          sandbox="allow-scripts"
          srcDoc={rewriteRefs(file.content, files, path)}
        />
      )}
      {mode === "preview" && kind === "markdown" && (
        <iframe
          className="preview-frame"
          data-testid="preview-frame"
          sandbox="allow-scripts"
          srcDoc={renderMarkdownDoc(file.content)}
        />
      )}
      {mode === "preview" && kind === "js" && (
        <div>
          <div className="preview-coming-soon" data-testid="preview-coming-soon">
            Component preview coming soon
          </div>
          <pre className="file-content">
            <code>{file.content}</code>
          </pre>
        </div>
      )}
      {mode === "source" && (
        <pre className="file-content">
          <code>{file.content}</code>
        </pre>
      )}
    </div>
  );
}
