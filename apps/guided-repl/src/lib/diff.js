/**
 * Simple line-based diff for small files (LCS-based).
 *
 * @typedef {{type: "same"|"add"|"del", line: string}} DiffLine
 */

/**
 * Computes a line-level diff between `prev` and `next` file contents.
 *
 * @param {string|undefined|null} prev
 * @param {string|undefined|null} next
 * @returns {DiffLine[]}
 */
export function diff(prev, next) {
  const prevLines = prev == null ? [] : prev.split("\n");
  const nextLines = next == null ? [] : next.split("\n");

  const n = prevLines.length;
  const m = nextLines.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        prevLines[i] === nextLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  /** @type {DiffLine[]} */
  const result = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (prevLines[i] === nextLines[j]) {
      result.push({ type: "same", line: prevLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      result.push({ type: "del", line: prevLines[i] });
      i++;
    } else {
      result.push({ type: "add", line: nextLines[j] });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: "del", line: prevLines[i] });
    i++;
  }
  while (j < m) {
    result.push({ type: "add", line: nextLines[j] });
    j++;
  }

  return result;
}
