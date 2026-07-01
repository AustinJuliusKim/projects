import React from "react";
import { buildTree } from "../lib/virtualFs.js";

// Renders the nested workspace tree. Clicking a file opens it in the viewer.
export default function FileTree({ files, openFile, onOpen }) {
  const tree = buildTree(files);
  const paths = Object.keys(files);
  if (paths.length === 0) {
    return <div className="file-tree empty muted">No files yet</div>;
  }
  return (
    <div className="file-tree">
      <Node node={tree} depth={0} openFile={openFile} onOpen={onOpen} />
    </div>
  );
}

function Node({ node, depth, openFile, onOpen }) {
  const names = Object.keys(node).sort((a, b) => {
    // dirs first, then files
    const da = node[a].__file ? 1 : 0;
    const db = node[b].__file ? 1 : 0;
    return da - db || a.localeCompare(b);
  });
  return (
    <ul>
      {names.map((name) => {
        const n = node[name];
        if (n.__file) {
          return (
            <li
              key={name}
              className={openFile === n.__path ? "file active" : "file"}
              style={{ paddingLeft: depth * 12 + 8 }}
              onClick={() => onOpen(n.__path)}
            >
              {name}
            </li>
          );
        }
        return (
          <li key={name}>
            <div className="dir" style={{ paddingLeft: depth * 12 + 8 }}>
              {name}/
            </div>
            <Node node={n.children} depth={depth + 1} openFile={openFile} onOpen={onOpen} />
          </li>
        );
      })}
    </ul>
  );
}
