import { test, expect } from "@playwright/test";
import {
  gotoLesson,
  pickChoices,
  promptPreview,
  runPrompt,
  waitForDone,
  fileTreeEntry,
  openFile,
} from "../helpers.js";

// Branch prompts are the lessons.json contract — fixtures may be re-recorded,
// but these strings (and index.html / <h1> grading) are stable.
const PROMPTS = {
  vague: "make a page about me, in index.html",
  "plan-mode":
    "make a personal landing page for my photography, single index.html file, inline CSS",
};

test("vague branch: replay completes, grades pass, workspace shows index.html", async ({
  page,
}) => {
  await gotoLesson(page);

  await pickChoices(page, {
    task: "make a page",
    subject: "about me",
    constraint: "in index.html",
  });
  // CLI-styled preview prepends a "> " prompt marker.
  await expect(promptPreview(page)).toHaveText(`> ${PROMPTS.vague}`);

  await runPrompt(page);

  // The submitted prompt is echoed as a user row in the transcript.
  await expect(page.getByTestId("transcript")).toContainText(PROMPTS.vague);

  const banner = await waitForDone(page);
  await expect(banner).toHaveClass(/grade-banner-pass/);

  // Replay produced tool activity and the graded file.
  expect(await page.getByTestId("transcript-tool-row").count()).toBeGreaterThan(0);
  await expect(fileTreeEntry(page, "index.html")).toBeVisible();
  await openFile(page, "index.html");
  await expect(page.getByTestId("diff-viewer")).toBeVisible();
});

test("plan-mode branch: parks on the permission gate, approve resumes to done", async ({
  page,
}) => {
  await gotoLesson(page);

  await pickChoices(page, {
    task: "make a personal landing page",
    subject: "for my photography",
    constraint: "single index.html file, inline CSS",
  });
  await expect(promptPreview(page)).toHaveText(`> ${PROMPTS["plan-mode"]}`);

  await runPrompt(page);

  // The fixture carries an awaitClient:"permission" gate mid-replay: the
  // modal must appear and playback must not finish until it is resolved.
  const modal = page.getByTestId("permission-modal");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("grade-banner")).not.toBeVisible();

  await page.getByTestId("approve-button").click();
  await expect(modal).not.toBeVisible();

  const banner = await waitForDone(page);
  await expect(banner).toHaveClass(/grade-banner-pass/);
  await expect(fileTreeEntry(page, "index.html")).toBeVisible();
});

test("lesson rail shows one active lesson and no locked stubs", async ({ page }) => {
  await gotoLesson(page);
  const rail = page.getByTestId("lesson-rail");
  await expect(rail).toBeVisible();
  await expect(rail.locator(".lesson-item-active")).toHaveCount(1);
  // All 8 lessons ship unlocked as of the L2-L8 rollout.
  await expect(rail.locator(".lesson-item-locked")).toHaveCount(0);
  await expect(rail.getByTestId("lesson-item")).toHaveCount(8);
  // Every lesson shows a kind chip.
  await expect(rail.getByTestId("lesson-kind")).toHaveCount(8);
  // L1 is a check (file-contains assertion), L2 is a quiz.
  await expect(page.locator('[data-lesson-id="l1"] .lesson-kind')).toHaveClass(/lesson-kind-check/);
  await expect(page.locator('[data-lesson-id="l2"] .lesson-kind')).toHaveClass(/lesson-kind-quiz/);
});
