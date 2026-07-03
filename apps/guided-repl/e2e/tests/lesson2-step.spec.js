import { test, expect } from "@playwright/test";
import { gotoLesson, selectLesson, runPrompt, answerQuiz, stepThrough } from "../helpers.js";

test("l2: step-through with annotations, quiz retry then pass", async ({ page }) => {
  await gotoLesson(page);
  await selectLesson(page, "l2");

  // Single prefilled walkthrough branch — just run it.
  await runPrompt(page);

  // Playback pauses at the first annotated beat.
  await expect(page.getByTestId("annotation-card")).toBeVisible();
  await stepThrough(page);

  // Quiz lessons render the quiz card on done; grade-banner only mounts
  // after a correct answer (answerQuiz waits for the card itself).
  // Wrong answer first: feedback shows, card stays re-answerable.
  await answerQuiz(page, 1); // correctIndex is 0
  await expect(page.getByTestId("quiz-card")).toBeVisible();
  await expect(page.getByTestId("grade-banner")).toHaveCount(0);

  // Correct answer passes (exercises the fixed hook-order path).
  await answerQuiz(page, 0);
  const banner = page.getByTestId("grade-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveClass(/grade-banner-pass/);
});
