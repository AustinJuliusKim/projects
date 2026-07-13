import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { validateFixture } from "@guided-repl/protocol";
import { runSegment, recordSimpleBranch, recordPlanBranch, makeSeedWorkspace } from "../src/seedLib.js";
import { createFakeRunner, makeDraftScript } from "./fakes/fakeRunner.js";

const ASSERTION = { type: "file-contains", path: "eval.md", match: "recall" };

test("runSegment maps/normalizes/paces a fake stream", async () => {
  const runner = createFakeRunner(makeDraftScript());
  const workspace = makeSeedWorkspace();
  try {
    const events = await runSegment(
      { prompt: "write eval.md", cwd: workspace, permissionMode: "acceptEdits" },
      { runner },
    );
    const types = events.map((e) => e.frame.type);
    assert.deepEqual(types, ["session_ready", "text", "tool_use", "tool_result", "usage", "done"]);
    for (const e of events) assert.equal(typeof e.delayMs, "number");
    // model override is forwarded to the runner
    await runSegment({ prompt: "p", cwd: workspace, permissionMode: "acceptEdits", model: "claude-haiku-4-5" }, { runner });
    assert.equal(runner.calls.at(-1).model, "claude-haiku-4-5");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("recordSimpleBranch / recordPlanBranch build valid fixtures with the injected runner", async () => {
  const runner = createFakeRunner(makeDraftScript());
  const common = {
    lessonId: "lx",
    expectedPrompt: "write eval.md scoring recall",
    assertion: ASSERTION,
    claudeCodeVersion: "9.9.9 (Claude Code)",
    seedSnapshotId: "lx-input",
  };

  const simple = await recordSimpleBranch({ ...common, branchId: "simple", permissionMode: "acceptEdits" }, { runner });
  validateFixture(simple.fixture);
  assert.equal(simple.fixture.permissionMode, "acceptEdits");
  fs.rmSync(simple.workspace, { recursive: true, force: true });

  const plan = await recordPlanBranch({ ...common, branchId: "planned" }, { runner });
  validateFixture(plan.fixture);
  assert.equal(plan.fixture.permissionMode, "plan");
  assert.ok(plan.fixture.events.some((e) => e.awaitClient === "permission"));
  fs.rmSync(plan.workspace, { recursive: true, force: true });
});
