/**
 * Fake Runner for keyless tests: yields canned raw NDJSON events (the
 * shapes streamMapper understands) and can mutate the workspace like a real
 * `claude -p` run would, so post-run snapshots and assertions are real.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * @param {(opts: import("../../src/runner/runner.js").RunnerOptions) => object[]} scriptFor
 *   returns the raw event array for one run(); may write files into opts.cwd
 * @returns {{run: Function, calls: object[]}}
 */
export function createFakeRunner(scriptFor) {
  const calls = [];
  return {
    calls,
    run(opts) {
      calls.push({ ...opts });
      const events = scriptFor(opts);
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
}

/**
 * Canonical draft-lesson script: acceptEdits runs Write `fileName` into the
 * workspace (with matching tool_use/tool_result events); plan runs only
 * narrate. Model id mirrors a real system/init capture.
 *
 * @param {{fileName?: string, content?: string, model?: string}} [opts]
 */
export function makeDraftScript({ fileName = "eval.md", content = "recall: 0.82\n", model = "claude-sonnet-4-6" } = {}) {
  return ({ cwd, permissionMode }) => {
    // The real claude CLI reports symlink-resolved absolute paths (macOS
    // /var/folders → /private/var/folders); mirror that so the normalizer's
    // cwd-relative rewrite kicks in exactly like a live recording.
    const realCwd = fs.realpathSync(cwd);
    const init = { type: "system", subtype: "init", cwd: realCwd, model, permissionMode };
    const result = {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1200, output_tokens: 340 },
    };
    if (permissionMode === "plan") {
      return [
        init,
        { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Here is my plan: measure recall." } } },
        result,
      ];
    }
    const abs = path.join(realCwd, fileName);
    fs.writeFileSync(abs, content);
    return [
      init,
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Writing the evaluation." } } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_fake_1", name: "Write", input: { file_path: abs, content } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_fake_1", content: "File written" }] } },
      result,
    ];
  };
}
