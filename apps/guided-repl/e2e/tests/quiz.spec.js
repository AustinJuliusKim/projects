import { test, expect } from "@playwright/test";
import { gotoLesson, selectLesson, composePrompt, runPrompt, answerQuiz } from "../helpers.js";

test("l3: run the constrained rung, answer the quiz in the rail, pass", async ({ page }) => {
  await gotoLesson(page);
  await selectLesson(page, "l3");

  await composePrompt(page, { description: "the constrained restyle" });
  await runPrompt(page);

  // Quiz lessons show the quiz card once the run settles (grade-banner
  // mounts after a correct answer); answerQuiz waits for the card.
  await answerQuiz(page, 2); // plan-mode rung is the keyed answer
  const banner = page.getByTestId("grade-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveClass(/grade-banner-pass/);
});

test("quizzes are non-diegetic: the card renders in the rail, never the stage", async ({ page }) => {
  await gotoLesson(page);
  await selectLesson(page, "l3");

  await composePrompt(page, { description: "the constrained restyle" });
  await runPrompt(page);

  const rail = page.getByTestId("rail");
  await expect(rail.getByTestId("quiz-card")).toBeVisible();
  // The stage (terminal pane) must not contain quiz chrome.
  await expect(page.locator(".pane-stage").getByTestId("quiz-card")).toHaveCount(0);
});
