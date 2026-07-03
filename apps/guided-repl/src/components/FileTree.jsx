/**
 * Renders the virtual file tree (via lib/virtualFs.buildTree) as a
 * collapsible explorer: directories default expanded with a ▸/▾ disclosure,
 * indent guides show nesting depth, and files carry a badge when new
 * (prevContent === null) or modified (prevContent differs from content).
 * Clicking a file calls onOpen(path).
 */

import { useState } from "react";
import { buildTree } from "../lib/virtualFs.js";

/**
 * @param {import("../lib/virtualFs.js").VFile|undefined} file
 * @returns {{label: string, cls: string}|null}
 */
function fileBadge(file) {
  if (!file) return null;
  if (file.prevContent === null) return { label: "new", cls: "file-badge-new" };
  if (file.prevContent !== undefined && file.prevContent !== file.content) {
    return { label: "M", cls: "file-badge-modified" };
  }
  return null;
}

/**
 * @param {{node: object, files: import("../lib/virtualFs.js").VFiles, openFile: string|null, onOpen: (path: string) => void, depth: number}} props
 */
function Node({ node, files, openFile, onOpen, depth }) {
  if (node.type === "file") {
    const badge = fileBadge(files[node.path]);
    return (
      <div
        className={`file-node ${node.path === openFile ? "file-node-active" : ""}`}
        style={{ "--depth": depth }}
        onClick={() => onOpen(node.path)}
      >
        <span className="file-node-name">{node.name}</span>
        {badge && (
          <span className={`file-badge ${badge.cls}`} data-testid="file-badge">
            {badge.label}
          </span>
        )}
      </div>
    );
  }

  return <DirNode node={node} files={files} openFile={openFile} onOpen={onOpen} depth={depth} />;
}

/**
 * @param {{node: object, files: import("../lib/virtualFs.js").VFiles, openFile: string|null, onOpen: (path: string) => void, depth: number}} props
 */
function DirNode({ node, files, openFile, onOpen, depth }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="dir-node">
      {node.name && (
        <button
          type="button"
          className="dir-node-name"
          data-testid="dir-toggle"
          style={{ "--depth": depth }}
          onClick={() => setExpanded((e) => !e)}
        >
          <span className="disclosure">{expanded ? "▾" : "▸"}</span>
          {node.name}/
        </button>
      )}
      {expanded && (
        <div className="dir-node-children">
          {node.children.map((child) => (
            <Node node={child} files={files} openFile={openFile} onOpen={onOpen} depth={depth + 1} key={child.path} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * @param {{files: import("../lib/virtualFs.js").VFiles, openFile: string|null, onOpen: (path: string) => void}} props
 */
export default function FileTree({ files, openFile, onOpen }) {
  const tree = buildTree(files);
  return (
    <div className="file-tree" data-testid="file-tree">
      {tree.map((node) => (
        <Node node={node} files={files} openFile={openFile} onOpen={onOpen} depth={0} key={node.path} />
      ))}
    </div>
  );
}
