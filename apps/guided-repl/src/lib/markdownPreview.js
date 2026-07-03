/**
 * Renders markdown into a full standalone HTML document for use as an
 * iframe's srcDoc. CSS is hardcoded (not var(--cli-*)) because the iframe
 * has no access to the parent document's custom properties.
 */

import { marked } from "marked";

// Hardcoded copies of the CLI theme tokens from styles.css :root.
const CSS = `
  body {
    margin: 0;
    padding: 24px;
    background: #0c0c0d;
    color: #e8e6e3;
    font-family: "SF Mono", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace;
    line-height: 1.6;
  }
  a { color: #e8845c; }
  code, pre {
    background: #1c1c1e;
    border: 1px solid #2e2e30;
    border-radius: 4px;
  }
  code { padding: 0.1em 0.3em; }
  pre { padding: 12px; overflow-x: auto; }
  pre code { border: none; padding: 0; }
  blockquote {
    border-left: 3px solid #2e2e30;
    margin-left: 0;
    padding-left: 12px;
    color: #8a8a8e;
  }
`;

/**
 * @param {string} md
 * @returns {string} a full HTML document
 */
export function renderMarkdownDoc(md) {
  const body = marked.parse(md);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}
