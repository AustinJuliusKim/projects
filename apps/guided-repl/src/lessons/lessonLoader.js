/**
 * Loads the compiled lesson manifest (built by @guided-repl/lessons from the
 * YAML sources) plus a selected lesson's branch fixtures and seed
 * snapshot(s). `indexLessons` is the pure validate/reshape step — the
 * manifest is validated against the protocol's Zod lesson schema, then each
 * lesson is reshaped into the flat structures downstream code consumes.
 *
 * @typedef {{branchId: string, expectedPrompt: string|null, permissionMode: string|null, fixturePath: string, seedSnapshotId: string}} IndexedBranch
 * @typedef {object} IndexedLesson
 * @property {string} lessonId
 * @property {string} title
 * @property {boolean} locked
 * @property {string} [seedSnapshotId]
 * @property {"step"|undefined} [playback]
 * @property {Array<object>} [steps] authored steps (the engine's input)
 * @property {Array<object>} [suggestions] promptBuilder suggestions
 * @property {{assertionIds: string[], next: string|null}} [completion]
 * @property {Record<string, Record<number, {title?: string, body: string}>>} [annotationsByBranch]
 * @property {IndexedBranch[]} [branches]
 * @typedef {{lessonId: string, title: string, locked: true}} IndexedStub
 */

import { validateLessonManifest } from "@guided-repl/protocol";

/**
 * Reshapes one compiled lesson into the flat shape downstream code consumes.
 * Locked entries pass through as stubs (lessonId/title/locked only).
 *
 * @param {object} lesson a schema-validated compiled lesson
 * @returns {IndexedLesson|IndexedStub}
 */
function indexOneLesson(lesson) {
  if (lesson.locked) {
    return { lessonId: lesson.id, title: lesson.title, locked: true };
  }

  const runStep = lesson.steps.find((s) => s.type === "run");
  const builderStep = lesson.steps.find((s) => s.type === "promptBuilder");
  if (!runStep) {
    throw new Error(`Invalid lesson ${lesson.id}: no run step`);
  }

  const branches = Object.entries(runStep.branches).map(([branchId, branch]) => ({
    branchId,
    expectedPrompt: branch.expectedPrompt,
    permissionMode: branch.permissionMode,
    fixturePath: lesson.fixtures[branch.fixture].path,
    // Per-branch seed snapshot override (e.g. L7's without/with CLAUDE.md
    // branches), falling back to the lesson-level snapshot.
    seedSnapshotId: branch.seedSnapshotId ?? lesson.snapshot.snapshotId,
  }));

  // Drill transcripts play through the same transport as run branches, keyed
  // by a step-scoped pseudo branch id (no prompt matching — the composer
  // submits the drill's branchId explicitly after matchCommand passes).
  const drillBranches = lesson.steps
    .filter((s) => s.type === "terminalDrill")
    .map((step) => ({
      branchId: `drill:${step.id}`,
      expectedPrompt: null,
      permissionMode: null,
      fixturePath: lesson.fixtures[step.transcript].path,
      seedSnapshotId: lesson.snapshot.snapshotId,
    }));

  // Anchored annotations, resolved by the compiler to event indices, grouped
  // per branch whose fixture the annotation targets.
  const annotationsByBranch = {};
  for (const step of lesson.steps) {
    if (step.type !== "annotation") continue;
    const targetPath = lesson.fixtures[step.fixtureKey].path;
    for (const branch of branches) {
      if (branch.fixturePath !== targetPath) continue;
      annotationsByBranch[branch.branchId] ??= {};
      annotationsByBranch[branch.branchId][step.resolvedEventIndex] = { body: step.md };
    }
  }

  return {
    lessonId: lesson.id,
    title: lesson.title,
    locked: false,
    seedSnapshotId: lesson.snapshot.snapshotId,
    playback: runStep.pacing === "step" ? "step" : undefined,
    steps: lesson.steps,
    suggestions: builderStep?.suggestions ?? [],
    completion: lesson.completion,
    annotationsByBranch,
    branches: [...branches, ...drillBranches],
  };
}

/**
 * Validates a compiled lesson manifest and reshapes it into a flat list of
 * every lesson (unlocked entries fully resolved, locked entries as stubs).
 * Pure — no I/O.
 *
 * @param {object} manifest the compiled {schemaVersion, lessons} document
 * @returns {Array<IndexedLesson|IndexedStub>}
 */
export function indexLessons(manifest) {
  const validated = validateLessonManifest(manifest);
  return validated.lessons.map(indexOneLesson);
}

/**
 * @param {string} url
 * @returns {Promise<object>}
 */
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * BASE_URL is "/" by default; a naive `${baseUrl}/fixtures` yields the
 * protocol-relative "//fixtures/..." (host lookup), so normalize once.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
function normalizeBase(baseUrl) {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

/**
 * Fetches every branch fixture (incl. drill transcripts) and the seed
 * snapshot(s) for one already-indexed, unlocked lesson. Branches may
 * override the lesson-level seedSnapshotId; each distinct snapshot id is
 * fetched once and attached both per-branch and at the lesson level.
 *
 * @param {string} base normalized base ("/" trailing slash)
 * @param {string} version
 * @param {IndexedLesson} lesson
 * @returns {Promise<{branches: Array<object>, snapshot: object}>}
 */
async function fetchLessonAssets(base, version, lesson) {
  const snapshotIds = Array.from(
    new Set([lesson.seedSnapshotId, ...lesson.branches.map((b) => b.seedSnapshotId)])
  );
  const [branchFixtures, snapshotEntries] = await Promise.all([
    Promise.all(lesson.branches.map((branch) => fetchJson(`${base}fixtures/${version}/${branch.fixturePath}`))),
    Promise.all(
      snapshotIds.map(async (id) => [id, await fetchJson(`${base}fixtures/${version}/snapshots/${id}.json`)])
    ),
  ]);
  const snapshotsById = Object.fromEntries(snapshotEntries);

  const branches = lesson.branches.map((branch, i) => ({
    branchId: branch.branchId,
    expectedPrompt: branch.expectedPrompt,
    permissionMode: branch.permissionMode,
    fixture: branchFixtures[i],
    snapshot: snapshotsById[branch.seedSnapshotId],
  }));

  return { branches, snapshot: snapshotsById[lesson.seedSnapshotId] };
}

/**
 * Fetches lessons.json and loads the selected lesson's branch fixtures +
 * snapshot(s). Throws if the lesson is unknown or locked.
 *
 * @param {string} baseUrl
 * @param {string} version
 * @param {string} lessonId
 * @returns {Promise<{lesson: IndexedLesson, lessons: Array<IndexedLesson|IndexedStub>, branches: Array<object>, snapshot: object}>}
 */
export async function loadLesson(baseUrl, version, lessonId) {
  const base = normalizeBase(baseUrl);
  const manifest = await fetchJson(`${base}fixtures/${version}/lessons.json`);
  const lessons = indexLessons(manifest);

  const lesson = lessons.find((l) => l.lessonId === lessonId);
  if (!lesson) {
    throw new Error(`Unknown lesson "${lessonId}"`);
  }
  if (lesson.locked) {
    throw new Error(`Lesson "${lessonId}" is locked`);
  }

  const { branches, snapshot } = await fetchLessonAssets(base, version, lesson);
  return { lesson, lessons, branches, snapshot };
}
