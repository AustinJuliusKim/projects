/**
 * Page-object-ish helpers for guided-repl e2e specs.
 *
 * Convention: every spec opens the lesson at `/?speed=0` so the fixture player
 * replays instantly (speedMultiplier 0 => no setTimeout waits). Assertions then
 * only need Playwright's normal auto-waiting, not real-time pacing.
 */

import { expect } from "@playwright/test";

/**
 * Open the lesson at instant-replay speed and wait for fixtures to load
 * (prompt-composer only renders once lessons.json + the L1 fixture resolve).
 *
 * @param {import("@playwright/test").Page} page
 */
export async function gotoLesson(page) {
  await page.goto("/?speed=0");
  await expect(page.getByTestId("prompt-composer")).toBeVisible();
}

/**
 * The composer's text input.
 *
 * @param {import("@playwright/test").Page} page
 * @returns {import("@playwright/test").Locator}
 */
export function composerInput(page) {
  return page.getByTestId("composer-input");
}

/**
 * Composes a prompt via the autocompletion menu: focuses the input and picks
 * the suggestion whose description (or text) matches. Picking by description
 * disambiguates branches that share identical prompt text.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{text?: string, description?: string}} target
 */
export async function composePrompt(page, { text, description } = {}) {
  // Clear any stale text first — the menu filters on the current input.
  await composerInput(page).fill("");
  await composerInput(page).click();
  const menu = page.getByTestId("composer-menu");
  await expect(menu).toBeVisible();
  const option = description
    ? menu.getByTestId("composer-option").filter({ hasText: description })
    : menu.getByTestId("composer-option").filter({ hasText: text }).first();
  await option.click();
  await expect(composerInput(page)).toHaveValue(text ?? /.+/);
}

/**
 * Submit the composed prompt (clicks Run).
 *
 * @param {import("@playwright/test").Page} page
 */
export async function runPrompt(page) {
  await page.getByTestId("run-button").click();
}

/**
 * Wait for the replay to finish — the grade banner only mounts on status "done".
 *
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<import("@playwright/test").Locator>}
 */
export async function waitForDone(page) {
  const banner = page.getByTestId("grade-banner");
  await expect(banner).toBeVisible();
  return banner;
}

/**
 * A file entry in the workspace file tree, located by name.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} name
 * @returns {import("@playwright/test").Locator}
 */
export function fileTreeEntry(page, name) {
  return page.getByTestId("file-tree").getByText(name, { exact: true });
}

/**
 * Open a file in the workspace by clicking its tree entry.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} name
 */
export async function openFile(page, name) {
  await fileTreeEntry(page, name).click();
}

/**
 * Switches the active lesson via the LessonRail and waits for the newly
 * selected lesson's prompt-builder to render (the rail's active class flips
 * synchronously on click; App.jsx briefly unmounts prompt-builder while the
 * new lesson's fixtures/snapshot fetch resolves, then remounts it).
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} lessonId
 */
export async function selectLesson(page, lessonId) {
  const item = page.locator(`[data-testid="lesson-item"][data-lesson-id="${lessonId}"]`);
  await item.click();
  await expect(item).toHaveClass(/lesson-item-active/);
  await expect(page.getByTestId("prompt-composer")).toBeVisible();
}

/**
 * Answers the quiz card: selects the choice at `choiceIndex` and submits.
 *
 * @param {import("@playwright/test").Page} page
 * @param {number} choiceIndex
 */
export async function answerQuiz(page, choiceIndex) {
  const card = page.getByTestId("quiz-card");
  await expect(card).toBeVisible();
  await card.getByTestId("quiz-choice").nth(choiceIndex).locator("input[type=radio]").check();
  await card.getByTestId("quiz-submit").click();
}

/**
 * Advances step-mode playback: while an annotation-card is showing, clicks
 * step-next. Bounded so a stuck player fails loudly instead of hanging.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{max?: number}} [opts]
 */
export async function stepThrough(page, { max = 10 } = {}) {
  const card = page.getByTestId("annotation-card");
  for (let i = 0; i < max; i++) {
    if ((await card.count()) === 0) return;
    await expect(card).toBeVisible();
    await page.getByTestId("step-next").click();
  }
  // Final check (with Playwright's normal auto-wait) rather than throwing
  // immediately — gives the last click's re-render a chance to land.
  await expect(card).toHaveCount(0);
}

/**
 * Locates a dir-toggle row in the file tree by its directory name.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} dirName
 * @returns {import("@playwright/test").Locator}
 */
export function dirToggle(page, dirName) {
  return page.getByTestId("dir-toggle").filter({ hasText: dirName });
}

/**
 * Expands a directory node in the file tree if it's currently collapsed.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} dirName
 */
export async function expandDir(page, dirName) {
  const toggle = dirToggle(page, dirName);
  const disclosure = toggle.locator(".disclosure");
  if ((await disclosure.textContent()) === "▸") {
    await toggle.click();
  }
}

/**
 * Collapses a directory node in the file tree if it's currently expanded.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} dirName
 */
export async function collapseDir(page, dirName) {
  const toggle = dirToggle(page, dirName);
  const disclosure = toggle.locator(".disclosure");
  if ((await disclosure.textContent()) === "▾") {
    await toggle.click();
  }
}

/**
 * The file-badge ("new"/"M") for a given file tree entry, scoped to that
 * file's row so it doesn't collide with other files' badges.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} name
 * @returns {import("@playwright/test").Locator}
 */
export function fileBadge(page, name) {
  return page
    .getByTestId("file-tree")
    .locator(".file-node")
    .filter({ has: page.getByText(name, { exact: true }) })
    .getByTestId("file-badge");
}
