/**
 * Splices a plan-mode run and its acceptEdits execution tail into a single
 * fixture event sequence, synthesizing the `permission_request` +
 * `awaitClient: "permission"` gate between them (headless
 * `--permission-mode plan` runs don't park for approval or expose
 * ExitPlanMode on their own — see RECORDER.md).
 */

const PLAN_EXCERPT_MAX_LEN = 500;

/**
 * Finds the plan markdown content written by the plan run (a `Write`
 * tool_use whose normalized file_path ends in `plan.md`), and returns a
 * short excerpt suitable for the synthesized permission_request payload.
 *
 * @param {import("@guided-repl/protocol").FixtureEvent[]} planEvents
 * @returns {string}
 */
function excerptPlanText(planEvents) {
  for (const e of planEvents) {
    const frame = e.frame;
    if (!frame || frame.type !== "tool_use") continue;
    const input = frame.payload?.input;
    if (
      input &&
      typeof input.file_path === "string" &&
      input.file_path.endsWith("plan.md") &&
      typeof input.content === "string"
    ) {
      const content = input.content.trim();
      return content.length > PLAN_EXCERPT_MAX_LEN
        ? `${content.slice(0, PLAN_EXCERPT_MAX_LEN)}…`
        : content;
    }
  }
  return "";
}

/**
 * Splices N run segments (plan revisions followed by a final execution run)
 * into a single fixture event sequence, synthesizing an ExitPlanMode
 * `permission_request` + `awaitClient: "permission"` gate between each pair
 * of adjacent segments (headless `--permission-mode plan` runs don't park
 * for approval or expose ExitPlanMode on their own — see RECORDER.md).
 *
 * Every segment but the first has its `session_ready` dropped (only the
 * first segment's init survives, so the fixture carries a single init at
 * the top). Every segment but the last has its terminal `usage`/`done`
 * dropped (those frames would flip status to "done" and trigger grading
 * before the final gate is ever reached) — only the last segment's terminal
 * usage/done remain.
 *
 * @param {import("@guided-repl/protocol").FixtureEvent[][]} segments
 * @param {string[][]} gateChoicesList one choices[] array per gate, length
 *   must be `segments.length - 1`
 * @returns {import("@guided-repl/protocol").FixtureEvent[]}
 */
export function applyMultiPlanGate(segments, gateChoicesList) {
  if (!Array.isArray(segments) || segments.length < 2) {
    throw new Error("applyMultiPlanGate requires at least 2 segments");
  }
  if (!Array.isArray(gateChoicesList) || gateChoicesList.length !== segments.length - 1) {
    throw new Error("applyMultiPlanGate requires exactly segments.length - 1 gate choice lists");
  }

  const stripTerminal = (events) =>
    events.filter((e) => !("frame" in e) || (e.frame.type !== "usage" && e.frame.type !== "done"));
  const stripInit = (events) => events.filter((e) => !("frame" in e) || e.frame.type !== "session_ready");

  const out = [];
  segments.forEach((segment, i) => {
    const isFirst = i === 0;
    const isLast = i === segments.length - 1;

    let body = segment;
    if (!isFirst) body = stripInit(body);
    if (!isLast) body = stripTerminal(body);
    out.push(...body);

    if (!isLast) {
      const permissionRequest = {
        frame: {
          type: "permission_request",
          payload: {
            id: `plan-gate-${i + 1}`,
            tool: "ExitPlanMode",
            input: { plan: excerptPlanText(segment) },
          },
        },
        delayMs: 0,
      };
      const gate = { awaitClient: "permission", choices: gateChoicesList[i] };
      out.push(permissionRequest, gate);
    }
  });

  return out;
}

/**
 * Splices a plan-mode run and its acceptEdits execution tail into a single
 * fixture event sequence. Thin wrapper over `applyMultiPlanGate` for the
 * common 2-segment ["approve", "deny"] case.
 *
 * @param {import("@guided-repl/protocol").FixtureEvent[]} planEvents
 * @param {import("@guided-repl/protocol").FixtureEvent[]} executionEvents
 * @returns {import("@guided-repl/protocol").FixtureEvent[]}
 */
export function applyAuthorGate(planEvents, executionEvents) {
  return applyMultiPlanGate([planEvents, executionEvents], [["approve", "deny"]]);
}
