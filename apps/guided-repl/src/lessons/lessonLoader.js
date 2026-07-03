/**
 * Loads lessons.json plus a selected lesson's branch fixtures and seed
 * snapshot(s). `indexLessons` is the pure validate/reshape step (returns
 * every lesson — unlocked ones fully resolved, locked ones as stubs) and is
 * unit-tested directly against plain objects; `loadLesson` layers the
 * fetches (all branches of the SELECTED lesson, fetched eagerly) on top of
 * it. `loadLessons` is a back-compat wrapper that loads the first unlocked
 * lesson.
 *
 * @typedef {{branchId: string, expectedPrompt: string, permissionMode: string, fixturePath: string, seedSnapshotId: string}} IndexedBranch
 * @typedef {object} IndexedLesson
 * @property {string} lessonId
 * @property {string} title
 * @property {boolean} locked
 * @property {string} [seedSnapshotId]
 * @property {"step"|"auto"|undefined} [playback]
 * @property {object} [promptChoices]
 * @property {object} [assertion]
 * @property {IndexedBranch[]} [branches]
 * @typedef {{lessonId: string, title: string, locked: true}} IndexedStub
 */

/**
 * Validates and reshapes one raw lessons.json entry. Locked entries pass
 * through as stubs (lessonId/title/locked only); unlocked entries are
 * validated and reshaped in full (branchConfig required, playback checked).
 *
 * @param {object} raw
 * @returns {IndexedLesson|IndexedStub}
 */
function indexOneLesson(raw) {
  if (!raw || !raw.lessonId) {
    throw new Error("Invalid lessons.json: each lesson needs a lessonId");
  }
  if (raw.locked) {
    return { lessonId: raw.lessonId, title: raw.title, locked: true };
  }
  if (!raw.branchConfig) {
    throw new Error(`Invalid lessons.json: lesson ${raw.lessonId} is missing branchConfig`);
  }
  if (raw.playback !== undefined && raw.playback !== "step" && raw.playback !== "auto") {
    throw new Error(`Invalid lessons.json: lesson ${raw.lessonId} has invalid playback "${raw.playback}"`);
  }

  const branchIds = raw.branches ?? [];
  const branches = branchIds.map((branchId) => {
    const config = raw.branchConfig[branchId];
    if (!config) {
      throw new Error(`Invalid lessons.json: missing branchConfig for branch "${branchId}"`);
    }
    return {
      branchId,
      expectedPrompt: config.expectedPrompt,
      permissionMode: config.permissionMode,
      fixturePath: config.fixture,
      // Per-branch seed snapshot override (e.g. L7's without/with CLAUDE.md
      // branches), falling back to the lesson-level snapshot.
      seedSnapshotId: config.seedSnapshotId ?? raw.seedSnapshotId,
    };
  });

  return {
    lessonId: raw.lessonId,
    title: raw.title,
    locked: false,
    seedSnapshotId: raw.seedSnapshotId,
    playback: raw.playback,
    promptChoices: raw.promptChoices,
    assertion: raw.assertion,
    branches,
  };
}

/**
 * Validates and reshapes a raw lessons.json document into a flat list of
 * every lesson (unlocked entries fully resolved, locked entries as stubs).
 * Pure — no I/O.
 *
 * @param {object} lessonsJson
 * @returns {Array<IndexedLesson|IndexedStub>}
 */
export function indexLessons(lessonsJson) {
  const lessons = lessonsJson?.lessons;
  if (!Array.isArray(lessons) || lessons.length === 0) {
    throw new Error("Invalid lessons.json: lessons must be a non-empty array");
  }
  return lessons.map(indexOneLesson);
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
 * Fetches every branch fixture and the seed snapshot(s) for one already-
 * indexed, unlocked lesson. Branches may override the lesson-level
 * seedSnapshotId; each distinct snapshot id is fetched once and attached
 * both per-branch and at the lesson level (back-compat with single-snapshot
 * lessons).
 *
 * @param {string} base normalized base ("/" trailing slash)
 * @param {string} version
 * @param {IndexedLesson} lesson
 * @returns {Promise<{branches: Array<{branchId: string, expectedPrompt: string, permissionMode: string, fixture: object, snapshot: object}>, snapshot: object}>}
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
  const lessonsJson = await fetchJson(`${base}fixtures/${version}/lessons.json`);
  const lessons = indexLessons(lessonsJson);

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

/**
 * Back-compat wrapper: loads lessons.json and the first unlocked lesson's
 * branch fixtures + snapshot(s), reshaping the result into the pre-refactor
 * {active, stubs, branches, snapshot} shape.
 *
 * @param {string} baseUrl
 * @param {string} version
 * @returns {Promise<{active: IndexedLesson, stubs: Array<IndexedLesson|IndexedStub>, branches: Array<object>, snapshot: object}>}
 */
export async function loadLessons(baseUrl, version) {
  const base = normalizeBase(baseUrl);
  const lessonsJson = await fetchJson(`${base}fixtures/${version}/lessons.json`);
  const lessons = indexLessons(lessonsJson);

  const active = lessons.find((l) => !l.locked);
  if (!active) {
    throw new Error("Invalid lessons.json: no unlocked lesson found");
  }
  const stubs = lessons.filter((l) => l.lessonId !== active.lessonId);

  const { branches, snapshot } = await fetchLessonAssets(base, version, active);
  return { active, stubs, branches, snapshot };
}
