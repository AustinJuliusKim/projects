/**
 * Optimistic virtual filesystem applied over the frame/tool-use stream.
 *
 * @typedef {{content: string, prevContent: (string|undefined)}} VFile
 * @typedef {Record<string, VFile>} VFiles
 * @typedef {{name: string, path: string, type: "file"}} TreeFileNode
 * @typedef {{name: string, path: string, type: "dir", children: Array<TreeFileNode|TreeDirNode>}} TreeDirNode
 */

/**
 * Normalizes a path to workspace-relative form (strips leading "./" and "/").
 *
 * @param {string} path
 * @returns {string}
 */
export function normalizePath(path) {
  return path.replace(/^(\.\/|\/)+/, "");
}

/**
 * @param {VFiles} files
 * @param {string} path
 * @returns {VFile|undefined}
 */
export function getFile(files, path) {
  return files[normalizePath(path)];
}

/**
 * Applies a single tool_use (Write/Edit/MultiEdit) to the files map,
 * returning a new map. Unknown tools are a no-op.
 *
 * @param {VFiles} files
 * @param {string} tool
 * @param {object} input
 * @returns {VFiles}
 */
export function applyToolUse(files, tool, input) {
  if (tool !== "Write" && tool !== "Edit" && tool !== "MultiEdit") {
    return files;
  }

  const path = normalizePath(input.file_path);
  const existing = files[path];

  if (tool === "Write") {
    // null (not undefined) marks a file the run created: renders as an
    // all-adds diff, while seeded files (prevContent undefined) render plain.
    return { ...files, [path]: { content: input.content, prevContent: existing ? existing.content : null } };
  }

  const prevContent = existing?.content ?? "";
  let content = prevContent;

  if (tool === "Edit") {
    // Function replacer: keeps $-sequences in new_string literal.
    content = content.replace(input.old_string, () => input.new_string);
  } else {
    for (const edit of input.edits) {
      content = content.replace(edit.old_string, () => edit.new_string);
    }
  }

  return { ...files, [path]: { content, prevContent } };
}

/**
 * Merges a file_tree frame's tree into the files map, seeding empty-content
 * entries for any file paths not already present. Existing entries (e.g.
 * already populated via file_content or a tool_use) are left untouched.
 *
 * @param {VFiles} files
 * @param {{tree: Array<{path: string, type: string}>}} tree
 * @returns {VFiles}
 */
export function mergeTree(files, tree) {
  const entries = tree?.tree ?? [];
  const next = { ...files };
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const path = normalizePath(entry.path);
    if (!(path in next)) {
      next[path] = { content: "", prevContent: undefined };
    }
  }
  return next;
}

/**
 * Converts the flat files map into a nested tree for UI rendering.
 *
 * @param {VFiles} files
 * @returns {Array<TreeFileNode|TreeDirNode>}
 */
export function buildTree(files) {
  /** @type {TreeDirNode} */
  const root = { name: "", path: "", type: "dir", children: [] };
  const dirs = new Map([["", root]]);

  function getDir(path) {
    if (dirs.has(path)) return dirs.get(path);
    const idx = path.lastIndexOf("/");
    const parentPath = idx === -1 ? "" : path.slice(0, idx);
    const name = idx === -1 ? path : path.slice(idx + 1);
    const parent = getDir(parentPath);
    /** @type {TreeDirNode} */
    const dir = { name, path, type: "dir", children: [] };
    parent.children.push(dir);
    dirs.set(path, dir);
    return dir;
  }

  for (const path of Object.keys(files).sort()) {
    const idx = path.lastIndexOf("/");
    const parentPath = idx === -1 ? "" : path.slice(0, idx);
    const name = idx === -1 ? path : path.slice(idx + 1);
    const parent = getDir(parentPath);
    parent.children.push({ name, path, type: "file" });
  }

  return root.children;
}
