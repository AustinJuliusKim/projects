import React from "react";
import FileTree from "./FileTree.jsx";
import FileViewer from "./FileViewer.jsx";

// The right pane: file tree + viewer/diff. This is "the resulting work".
export default function WorkspacePane({ files, openFile, onOpen, onRequestContent }) {
  return (
    <div className="workspace">
      <div className="workspace-sidebar">
        <div className="pane-title">Workspace</div>
        <FileTree files={files} openFile={openFile} onOpen={onOpen} />
      </div>
      <div className="workspace-main">
        <FileViewer
          path={openFile}
          file={openFile ? files[openFile] : null}
          onRequestContent={onRequestContent}
        />
      </div>
    </div>
  );
}
