import { test, expect } from "@playwright/test";
import { gotoLesson, selectLesson, composePrompt, runPrompt, answerQuiz, stepThrough } from "../helpers.js";

test("l2: step-through with annotations, quiz retry then pass", async ({ page }) => {
  await gotoLesson(page);
  await selectLesson(page, "l2");

  // Single walkthrough branch.
  await composePrompt(page, { description: "replay Lesson 1's run step by step" });
  await runPrompt(page);

  // Playback pauses at the first annotated beat.
  await expect(page.getByTestId("annotation-card")).toBeVisible();
  await stepThrough(page);

  // Quiz lessons render the quiz card once the run settles; grade-banner
  // only mounts after a correct answer (answerQuiz waits for the card).
  // Wrong answer first: feedback shows, card stays re-answerable.
  await answerQuiz(page, 1); // correctIndex is 0
  await expect(page.getByTestId("quiz-card")).toBeVisible();
  await expect(page.getByTestId("grade-banner")).toHaveCount(0);

  // Correct answer passes.
  await answerQuiz(page, 0);
  const banner = page.getByTestId("grade-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveClass(/grade-banner-pass/);
});
