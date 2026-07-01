import React from "react";
import CodeMirror from "@uiw/react-codemirror";
import ReactDiffViewer from "react-diff-viewer-continued";

// Shows the open file. If the file was edited this session (we have a previous
// version), show a diff; otherwise show the read-only source.
export default function FileViewer({ path, file, onRequestContent }) {
  if (!path) {
    return <div className="file-viewer empty muted">Select a file to view it</div>;
  }
  if (!file || file.content == null) {
    // Content not loaded yet (e.g. a bash-created file from the reconciled tree).
    if (onRequestContent) onRequestContent(path);
    return <div className="file-viewer empty muted">Loading {path}…</div>;
  }

  const hasDiff = file.prevContent != null && file.prevContent !== file.content;

  return (
    <div className="file-viewer">
      <div className="file-viewer-header">{path}</div>
      {hasDiff ? (
        <ReactDiffViewer
          oldValue={file.prevContent}
          newValue={file.content}
          splitView={false}
          useDarkTheme
        />
      ) : (
        <CodeMirror value={file.content} editable={false} theme="dark" height="100%" />
      )}
    </div>
  );
}
