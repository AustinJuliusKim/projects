/**
 * Judge hygiene for the Model Lab: a FIXED judge model (never a
 * contestant), pairwise comparisons over absolute scores at small n, rubric
 * derived from the locked pedagogy principles.
 */

export const JUDGE_SYSTEM = `You judge which of two 5-minute guided-repl lesson drafts teaches
better, against these locked pedagogy principles:
- one sharp counterfactual: branches contrast a single decision the learner feels
- copy is concise, active, on-task; instruction md sets up the run, no filler
- the quiz tests the actual insight, not trivia; distractors are plausible
- the assertion is the right proof the learner's run worked
- duration discipline: everything serves the 5-minute arc

You will see draft A and draft B for the same topic. Judge the TEACHING, not
the formatting. End your reply with exactly one line: "WINNER: A" or "WINNER: B".`;

/**
 * @param {{topic: string}} brief
 * @param {string} yamlA
 * @param {string} yamlB
 * @returns {string}
 */
export function buildJudgePrompt(brief, yamlA, yamlB) {
  return [
    `Topic: ${brief.topic}`,
    "",
    "--- DRAFT A ---",
    "```yaml",
    yamlA.trimEnd(),
    "```",
    "",
    "--- DRAFT B ---",
    "```yaml",
    yamlB.trimEnd(),
    "```",
  ].join("\n");
}

/**
 * @param {string} text judge response
 * @returns {"A"|"B"|null}
 */
export function parseJudgeVerdict(text) {
  const m = text.match(/WINNER:\s*([AB])\b/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * One pairwise comparison. The judge model is passed explicitly and pinned —
 * role routing must not silently swap it mid-sweep.
 *
 * @param {object} opts
 * @param {{complete: Function}} opts.agentClient
 * @param {string} opts.judgeModel
 * @param {{topic: string}} opts.brief
 * @param {{model: string, yamlText: string}} opts.a
 * @param {{model: string, yamlText: string}} opts.b
 * @returns {Promise<{winner: string|null, costUsd: number}>} winner = contestant model id
 */
export async function judgePair({ agentClient, judgeModel, brief, a, b }) {
  const { text, costUsd } = await agentClient.complete({
    role: "judge",
    model: judgeModel,
    system: JUDGE_SYSTEM,
    prompt: buildJudgePrompt(brief, a.yamlText, b.yamlText),
  });
  const verdict = parseJudgeVerdict(text);
  return { winner: verdict === "A" ? a.model : verdict === "B" ? b.model : null, costUsd };
}
