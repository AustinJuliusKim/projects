/**
 * Lint stage: structural caps as pure functions over a parsed (already
 * Zod-validated) lesson doc. Caps are hard failures with precise messages —
 * they feed the draft PR's review card. An optional LLM pass (role: linter)
 * adds advisory pedagogy notes behind --llm-lint; it never blocks.
 */

export const MAX_DURATION_SEC = 330;
export const MAX_RUN_BRANCHES = 3;
export const DRAFT_PERMISSION_MODES = new Set(["acceptEdits", "plan"]);

/**
 * @typedef {{rule: string, message: string}} LintFailure
 */

/**
 * @param {object} doc validated lesson doc
 * @param {{draftConstraints?: boolean}} [opts] draftConstraints (default true)
 *   additionally enforces the Foundry v1 constraints (self-contained
 *   snapshot, advanced track, simple/plan branch kinds only)
 * @returns {{ok: boolean, failures: LintFailure[]}}
 */
export function lintLessonDoc(doc, { draftConstraints = true } = {}) {
  /** @type {LintFailure[]} */
  const failures = [];
  const fail = (rule, message) => failures.push({ rule, message });

  if (doc.durationTargetSec > MAX_DURATION_SEC) {
    fail("duration-cap", `durationTargetSec ${doc.durationTargetSec} exceeds the 5-minute cap (${MAX_DURATION_SEC}s)`);
  }

  const runSteps = doc.steps.filter((s) => s.type === "run");
  for (const step of runSteps) {
    const count = Object.keys(step.branches).length;
    if (count > MAX_RUN_BRANCHES) {
      fail("branch-cap", `run step "${step.id}" has ${count} branches (max ${MAX_RUN_BRANCHES})`);
    }
  }

  const assertions = doc.steps.filter((s) => s.type === "assertion");
  if (assertions.length !== 1) {
    fail("single-assertion", `expected exactly one assertion step, found ${assertions.length}`);
  }

  const stepIds = new Set(doc.steps.map((s) => s.id));
  for (const id of doc.completion.assertionIds) {
    if (!stepIds.has(id)) {
      fail("completion-refs", `completion.assertionIds references unknown step "${id}"`);
    }
  }
  if (assertions.length === 1 && !doc.completion.assertionIds.includes(assertions[0].id)) {
    fail("completion-refs", `completion.assertionIds must include the assertion step "${assertions[0].id}"`);
  }

  if (draftConstraints) {
    const expectedSnapshot = `${doc.id}-input`;
    if (doc.snapshot.snapshotId !== expectedSnapshot) {
      fail(
        "draft-snapshot",
        `Foundry drafts must be self-contained: snapshot.snapshotId "${doc.snapshot.snapshotId}" should be "${expectedSnapshot}"`,
      );
    }
    if (doc.track !== "advanced") {
      fail("draft-track", `Foundry drafts ship on track "advanced", got "${doc.track}"`);
    }
    for (const step of runSteps) {
      for (const [branchId, branch] of Object.entries(step.branches)) {
        if (!DRAFT_PERMISSION_MODES.has(branch.permissionMode)) {
          fail(
            "draft-permission-mode",
            `run "${step.id}" branch "${branchId}" uses permissionMode "${branch.permissionMode}" — v1 drafts support acceptEdits or plan only`,
          );
        }
        if (branch.seedSnapshotId && branch.seedSnapshotId !== expectedSnapshot) {
          fail(
            "draft-snapshot",
            `run "${step.id}" branch "${branchId}" seeds from "${branch.seedSnapshotId}" — drafts may only seed from "${expectedSnapshot}"`,
          );
        }
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

const LINTER_SYSTEM = `You are the Lesson Foundry's pedagogy linter for 5-minute guided-repl
lessons. Review the lesson YAML for teaching quality only (structure is
machine-checked separately): is the counterfactual contrast between branches
sharp, is the copy concise and active, does the quiz test the actual insight,
is the assertion the right proof of success? Reply with a short markdown
bullet list of advisory notes; reply "LGTM" if there is nothing worth raising.`;

/**
 * Optional LLM lint (role: linter) — advisory only, surfaced in the review
 * card, never a hard failure.
 *
 * @param {{agentClient: {complete: Function}, yamlText: string}} opts
 * @returns {Promise<{notes: string, costUsd: number, model: string}>}
 */
export async function llmLint({ agentClient, yamlText }) {
  const { text, costUsd, model } = await agentClient.complete({
    role: "linter",
    system: LINTER_SYSTEM,
    prompt: `\`\`\`yaml\n${yamlText}\n\`\`\``,
  });
  return { notes: text.trim(), costUsd, model };
}
