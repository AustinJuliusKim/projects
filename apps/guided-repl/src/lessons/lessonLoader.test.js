import { test } from "node:test";
import assert from "node:assert/strict";
import { indexLessons } from "./lessonLoader.js";

const sample = {
  lessons: [
    {
      lessonId: "l1",
      title: "Active",
      branches: ["vague", "constrained"],
      seedSnapshotId: "l1-input",
      promptChoices: { task: ["a"], subject: ["b"], constraint: ["c"] },
      branchConfig: {
        vague: { expectedPrompt: "make a page about me, in index.html", permissionMode: "acceptEdits", fixture: "fixtures/l1/vague.json" },
        constrained: { expectedPrompt: "make a personal landing page about me, single index.html file, inline CSS", permissionMode: "acceptEdits", fixture: "fixtures/l1/constrained.json" },
      },
      assertion: { type: "file-contains", path: "index.html", match: "<h1>" },
    },
    { lessonId: "l2", title: "Stub", locked: true },
  ],
};

test("indexLessons reshapes an unlocked lesson's branches", () => {
  const [l1] = indexLessons(sample);
  assert.equal(l1.lessonId, "l1");
  assert.equal(l1.locked, false);
  assert.deepEqual(l1.branches, [
    { branchId: "vague", expectedPrompt: "make a page about me, in index.html", permissionMode: "acceptEdits", fixturePath: "fixtures/l1/vague.json", seedSnapshotId: "l1-input" },
    { branchId: "constrained", expectedPrompt: "make a personal landing page about me, single index.html file, inline CSS", permissionMode: "acceptEdits", fixturePath: "fixtures/l1/constrained.json", seedSnapshotId: "l1-input" },
  ]);
});

test("indexLessons carries promptChoices and assertion through untouched", () => {
  const [l1] = indexLessons(sample);
  assert.deepEqual(l1.promptChoices, sample.lessons[0].promptChoices);
  assert.deepEqual(l1.assertion, sample.lessons[0].assertion);
});

test("indexLessons returns locked lessons as stubs (lessonId/title/locked only)", () => {
  const [, l2] = indexLessons(sample);
  assert.deepEqual(l2, { lessonId: "l2", title: "Stub", locked: true });
});

test("indexLessons returns every lesson, in order", () => {
  const lessons = indexLessons(sample);
  assert.deepEqual(lessons.map((l) => l.lessonId), ["l1", "l2"]);
});

test("indexLessons throws when lessons array is missing or empty", () => {
  assert.throws(() => indexLessons({}));
  assert.throws(() => indexLessons({ lessons: [] }));
});

test("indexLessons throws when a branch is missing branchConfig", () => {
  const broken = JSON.parse(JSON.stringify(sample));
  delete broken.lessons[0].branchConfig.vague;
  assert.throws(() => indexLessons(broken));
});

test("indexLessons defaults branch seedSnapshotId to the lesson-level id", () => {
  const [l1] = indexLessons(sample);
  assert.equal(l1.branches[0].seedSnapshotId, "l1-input");
  assert.equal(l1.branches[1].seedSnapshotId, "l1-input");
});

test("indexLessons honors a per-branch seedSnapshotId override", () => {
  const withOverride = JSON.parse(JSON.stringify(sample));
  withOverride.lessons[0].branchConfig.constrained.seedSnapshotId = "l7-input-claudemd";
  const [l1] = indexLessons(withOverride);
  assert.equal(l1.branches[0].seedSnapshotId, "l1-input");
  assert.equal(l1.branches[1].seedSnapshotId, "l7-input-claudemd");
});

test("indexLessons accepts playback step/auto/undefined", () => {
  const stepLesson = JSON.parse(JSON.stringify(sample));
  stepLesson.lessons[0].playback = "step";
  assert.equal(indexLessons(stepLesson)[0].playback, "step");

  const autoLesson = JSON.parse(JSON.stringify(sample));
  autoLesson.lessons[0].playback = "auto";
  assert.equal(indexLessons(autoLesson)[0].playback, "auto");

  assert.equal(indexLessons(sample)[0].playback, undefined);
});

test("indexLessons rejects an invalid playback value", () => {
  const broken = JSON.parse(JSON.stringify(sample));
  broken.lessons[0].playback = "fast-forward";
  assert.throws(() => indexLessons(broken));
});

test("indexLessons throws when a lesson entry has no lessonId", () => {
  const broken = JSON.parse(JSON.stringify(sample));
  delete broken.lessons[0].lessonId;
  assert.throws(() => indexLessons(broken));
});
