/**
 * `foundry queue` — lists the open review queue (draft PRs labeled
 * foundry:draft) via `gh pr list`, through an injected exec so tests stay
 * keyless and the CLI needs no gh auth to unit-test.
 */

import { execFile } from "node:child_process";

/**
 * @typedef {(cmd: string, args: string[]) => Promise<{stdout: string}>} ExecImpl
 */

/** @type {ExecImpl} */
function defaultExec(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });
}

/**
 * @param {{label: string, execImpl?: ExecImpl}} opts
 * @returns {Promise<{number: number, title: string, url: string, createdAt: string, headRefName: string, isDraft: boolean}[]>}
 */
export async function listQueue({ label, execImpl = defaultExec }) {
  const { stdout } = await execImpl("gh", [
    "pr",
    "list",
    "--label",
    label,
    "--state",
    "open",
    "--json",
    "number,title,url,createdAt,headRefName,isDraft",
  ]);
  return JSON.parse(stdout || "[]");
}

/**
 * @param {Awaited<ReturnType<typeof listQueue>>} prs
 * @param {string} label
 * @returns {string} human-readable queue listing
 */
export function formatQueue(prs, label) {
  if (prs.length === 0) return `Review queue empty — no open PRs labeled ${label}.`;
  const lines = prs.map((pr) => `#${pr.number}  ${pr.isDraft ? "[draft] " : ""}${pr.title}\n    ${pr.url}  (${pr.headRefName}, ${pr.createdAt})`);
  return [`${prs.length} PR(s) labeled ${label}:`, ...lines].join("\n");
}
