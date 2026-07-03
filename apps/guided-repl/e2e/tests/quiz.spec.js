import { test, expect } from "@playwright/test";
import { gotoLesson, selectLesson, pickChoices, runPrompt, answerQuiz } from "../helpers.js";

test("l3: run the constrained rung, answer the quiz, pass", async ({ page }) => {
  await gotoLesson(page);
  await selectLesson(page, "l3");

  await pickChoices(page, {
    task: "restyle the page",
    subject: "with a dark theme",
    constraint: "keep it one file, no frameworks",
  });
  await runPrompt(page);

  // Quiz lessons show the quiz card on done (grade-banner mounts after a
  // correct answer); answerQuiz waits for the card.
  await answerQuiz(page, 2); // plan-mode rung is the keyed answer
  const banner = page.getByTestId("grade-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveClass(/grade-banner-pass/);
});
