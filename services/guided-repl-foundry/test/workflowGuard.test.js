import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { loadConfig } from "../src/config.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PKG_ROOT, "../..");
const FOUNDRY_YML = path.join(REPO_ROOT, ".github/workflows/foundry.yml");
const GUIDED_REPL_YML = path.join(REPO_ROOT, ".github/workflows/guided-repl.yml");

const raw = fs.readFileSync(FOUNDRY_YML, "utf8");
const workflow = parseYaml(raw);
const { settings } = loadConfig();

/** Every run-step script in a workflow, concatenated. */
function allRunScripts(wf) {
  return Object.values(wf.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run ?? "")
    .join("\n");
}

test("never-full-auto-publish is structural: no merge, no push to main", () => {
  const scripts = allRunScripts(workflow);
  assert.ok(!/gh\s+pr\s+merge/.test(scripts), "workflow must never merge a PR");
  assert.ok(!/git\s+merge/.test(scripts), "workflow must never git-merge");
  assert.ok(!/push[^\n]*origin\s+main\b/.test(scripts), "workflow must never push to main");
  assert.ok(!/HEAD:main/.test(scripts), "workflow must never push HEAD:main");
  assert.ok(!/git\s+push\s+(-f|--force)/.test(scripts), "workflow must never force-push");
  // REST/GraphQL merges must not slip past the literal `gh pr merge` check.
  assert.ok(
    !/gh\s+api[\s\S]*?(merge|pulls\/.*\/merge|merge_method|mergePullRequest)/i.test(scripts),
    "workflow must never merge via gh api / GraphQL",
  );
  assert.ok(!/mergePullRequest|merge_method/i.test(raw), "no merge mutations anywhere in the workflow");
  // The only PR creation is DRAFT PR creation.
  const creates = scripts.match(/gh pr create[^\n]*(?:\n\s+--[^\n]+)*/g) ?? [];
  assert.ok(creates.length >= 1, "workflow opens draft PRs");
  for (const c of creates) {
    assert.match(c, /--draft/, `every gh pr create is --draft: ${c.split("\n")[0]}`);
  }
  // Branch pushes are variable-named foundry branches, never a literal ref.
  for (const push of scripts.match(/git push origin [^\n]+/g) ?? []) {
    assert.match(push, /^git push origin "\$branch"$/, `push must target the bundle branch var: ${push}`);
  }
});

test("foundry CLI sources contain no git/PR write operations", () => {
  const srcDir = path.join(PKG_ROOT, "src");
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js")) files.push(full);
    }
  })(srcDir);
  assert.ok(files.length >= 15, "walked the real source tree");
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(!/git\s+push|pr\s+merge|"merge"|simple-git|octokit/i.test(src), `${path.relative(PKG_ROOT, f)} must not write to git/PRs`);
    // `gh` may appear only in queue.js, and only as `gh pr list`.
    if (/\bexecFile\(|\bspawn\(|\bexec\(/.test(src) && !f.endsWith("queue.js")) {
      assert.ok(!/["']gh["']/.test(src), `${path.relative(PKG_ROOT, f)} must not shell out to gh`);
    }
  }
  const queueSrc = fs.readFileSync(path.join(srcDir, "pr/queue.js"), "utf8");
  assert.match(queueSrc, /"pr",\s*\n?\s*"list"/, "queue.js only lists PRs");
});

test("uses: steps are allowlisted — no marketplace actions can merge/publish", () => {
  const ALLOWED_USES = [/^actions\/checkout@/, /^actions\/setup-node@/];
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.uses) continue;
      assert.ok(
        ALLOWED_USES.some((re) => re.test(step.uses)),
        `job ${jobName}: uses "${step.uses}" is not in the allowlist — a third-party action could bypass the publish guard`,
      );
    }
  }
});

test("workflow permissions are exactly contents+pull-requests write", () => {
  assert.deepEqual(workflow.permissions, { contents: "write", "pull-requests": "write" });
  // and no job-level escalation
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.permissions, undefined, "no per-job permission overrides");
  }
});

test("cron matches foundry/settings.yaml cadenceCron", () => {
  const crons = workflow.on.schedule.map((s) => s.cron);
  assert.deepEqual(crons, [settings.cadenceCron]);
});

test("workflow_dispatch exposes mode/idea/top_n/models inputs", () => {
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ["idea", "mode", "models", "top_n"]);
  assert.deepEqual(inputs.mode.options, ["radar", "idea", "bench"]);
  assert.equal(inputs.mode.default, "radar");
});

test("keyless guard: absent secrets exit 0 with a notice; run steps are gated", () => {
  const steps = workflow.jobs.foundry.steps;
  const guard = steps.find((s) => s.id === "guard");
  assert.ok(guard, "guard step exists");
  assert.match(guard.run, /::notice::/);
  assert.match(guard.run, /skip=true/);
  for (const step of steps.slice(steps.indexOf(guard) + 1)) {
    assert.match(step.if ?? "", /steps\.guard\.outputs\.skip != 'true'/, `step "${step.name}" is guarded`);
  }
});

test("concurrency: single foundry group, never cancel a publish-adjacent run", () => {
  assert.deepEqual(workflow.concurrency, { group: "foundry", "cancel-in-progress": false });
});

test("FOUNDRY_PR_TOKEN preferred with GITHUB_TOKEN fallback + PR-body warning", () => {
  const scripts = allRunScripts(workflow);
  assert.match(raw, /secrets\.FOUNDRY_PR_TOKEN \|\| secrets\.GITHUB_TOKEN/);
  assert.match(scripts, /FOUNDRY_PR_TOKEN not set/);
  assert.match(scripts, /close\/reopen/);
});

test("guided-repl.yml gained the foundry job and path filters", () => {
  const ci = parseYaml(fs.readFileSync(GUIDED_REPL_YML, "utf8"));
  assert.ok(ci.jobs.foundry, "foundry test job present");
  const runs = (ci.jobs.foundry.steps ?? []).map((s) => s.run ?? "").join("\n");
  assert.match(runs, /npm test/);
  for (const paths of [ci.on.push.paths, ci.on.pull_request.paths]) {
    assert.ok(paths.includes("services/guided-repl-foundry/**"), "foundry package path filter");
    assert.ok(paths.includes("foundry/**"), "foundry config path filter");
  }
});
