/**
 * Right-hand workspace pane: file tree + file viewer. Auto-opens the most
 * recently written file.
 */

import { useEffect, useRef } from "react";
import FileTree from "./FileTree.jsx";
import FileViewer from "./FileViewer.jsx";
import { getFile } from "../lib/virtualFs.js";

/**
 * @param {{files: import("../lib/virtualFs.js").VFiles, openFile: string|null, onOpenFile: (path: string) => void}} props
 */
export default function WorkspacePane({ files, openFile, onOpenFile }) {
  const lastWrittenRef = useRef(null);

  useEffect(() => {
    const paths = Object.keys(files);
    if (paths.length === 0) return;
    const mostRecent = paths[paths.length - 1];
    if (mostRecent !== lastWrittenRef.current) {
      lastWrittenRef.current = mostRecent;
      onOpenFile(mostRecent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  return (
    <div className="workspace-pane" data-testid="workspace">
      <FileTree files={files} openFile={openFile} onOpen={onOpenFile} />
      <FileViewer path={openFile} file={getFile(files, openFile ?? "")} files={files} />
    </div>
  );
}
