/**
 * L2 "Why did it do that?" — a step-through replay of L1's `constrained`
 * run, hand-annotated at the three beats the lesson walks through: the
 * explore/plan narration, the Write tool call, and the verify step before
 * the agent wraps up. No live recording — see annotationMerge.js.
 */

export const recipe = {
  lessonId: "l2",
  kind: "merge",
  source: { lessonId: "l1", branchId: "constrained" },
  branchId: "walkthrough",
  annotations: [
    {
      index: 1,
      annotation: {
        title: "Explore, then plan",
        body:
          "The workspace only has a starter README — there's nothing to read or refactor, so the agentic loop's explore step is a no-op here. The model reasons about the task in this streamed text before touching any tool: single file, inline CSS, what content to invent from your prompt. That reasoning is the plan; it never gets shown as a separate step because there was nothing in the workspace worth exploring.",
      },
    },
    {
      index: 4,
      annotation: {
        title: "The Write tool call",
        body:
          "This is the one tool call in the whole run: `Write` with `file_path: \"index.html\"` and the full page content as `input.content`. This is the moment the plan becomes a real file — everything above was reasoning, this is the only step that changes the workspace. Because it's a single-file page, one Write call is enough to finish the job.",
      },
    },
    {
      index: 5,
      annotation: {
        title: "Verify before finishing",
        body:
          "The `tool_result` confirms the write succeeded and — notice the message — tells the model the file's content is already \"current in context,\" so it doesn't need to Read it back to check its own work. That confirmation is what lets the agent move straight to summarizing what it built instead of re-reading the file it just wrote.",
      },
    },
  ],
};
