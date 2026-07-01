// Applies Claude's Write/Edit tool_use events to a client-side virtual FS so
// the workspace pane updates instantly (and we can show old-vs-new diffs)
// without waiting for a sandbox round-trip. The backend later reconciles this
// against the real FS via file_tree / file_content messages.

// files: { [path]: { content, prevContent } }
export function applyToolUse(files, tool, input) {
  if (!input) return files;
  const next = { ...files };

  if (tool === "Write" && input.file_path) {
    const prev = next[input.file_path]?.content;
    next[input.file_path] = {
      content: input.content ?? "",
      prevContent: prev,
    };
  } else if ((tool === "Edit" || tool === "MultiEdit") && input.file_path) {
    const existing = next[input.file_path];
    const base = existing?.content ?? "";
    const edits =
      tool === "MultiEdit" ? input.edits ?? [] : [{ old_string: input.old_string, new_string: input.new_string }];
    let updated = base;
    for (const e of edits) {
      if (typeof e.old_string === "string") {
        updated = updated.replace(e.old_string, e.new_string ?? "");
      }
    }
    next[input.file_path] = { content: updated, prevContent: base };
  }
  return next;
}

// Merge a reconciled file_tree (list of {path,type}) so files created by bash
// (not via tool events) also appear. Keeps any content we already have.
export function mergeTree(files, tree) {
  const next = { ...files };
  for (const entry of tree) {
    if (entry.type === "file" && !(entry.path in next)) {
      next[entry.path] = { content: null, prevContent: undefined };
    }
  }
  return next;
}

// Build a nested tree structure for rendering from the flat file map.
export function buildTree(files) {
  const root = {};
  for (const path of Object.keys(files).sort()) {
    const parts = path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      node[part] = node[part] || { __file: isFile, __path: isFile ? path : null, children: {} };
      node = node[part].children;
    });
  }
  return root;
}
