import { test, expect } from "@playwright/test";
import { gotoLesson, selectLesson, composePrompt, runPrompt, answerQuiz } from "../helpers.js";

// Stage/Rail mode choreography (Lesson Engine Spec §3): instructing shows
// the expanded rail with instruction copy; running collapses it to a
// progress strip; reflecting re-expands it with the quiz/grade surface.
//
// Collapse is observed via l5's permission gate — at ?speed=0 a gate-less
// run completes synchronously, but the plan branch parks on
// awaiting_permission with the engine still in "running".

test("instructing: rail is expanded with instruction copy and progress dots", async ({ page }) => {
  await gotoLesson(page);
  const rail = page.getByTestId("rail");
  await expect(rail).toHaveAttribute("data-mode", "instructing");
  await expect(rail).not.toHaveClass(/rail-collapsed/);
  await expect(page.getByTestId("rail-instruction")).toContainText("Ship a page");
  await expect(page.getByTestId("rail-dot").first()).toHaveClass(/rail-dot-active/);
  await expect(page.getByTestId("rail-continue")).toBeVisible();
});

test("running: rail collapses to the progress strip while a run plays", async ({ page }) => {
  await gotoLesson(page);
  await selectLesson(page, "l5");

  await composePrompt(page, { description: "run in plan mode" });
  await runPrompt(page);

  // Parked on the permission gate: the engine is mid-run.
  await expect(page.getByTestId("permission-modal")).toBeVisible();
  const rail = page.getByTestId("rail");
  await expect(rail).toHaveAttribute("data-mode", "running");
  await expect(rail).toHaveClass(/rail-collapsed/);
  // The progress strip stays visible; the spine body does not.
  await expect(page.getByTestId("rail-progress")).toBeVisible();
  await expect(page.getByTestId("rail-instruction")).toHaveCount(0);

  // Resolving the gate finishes the run; the rail re-expands to reflect.
  await page.getByTestId("approve-button").click();
  await expect(rail).toHaveAttribute("data-mode", "reflecting");
  await expect(rail).not.toHaveClass(/rail-collapsed/);
});

test("reflecting → graduated: quiz and grade banner render in the rail", async ({ page }) => {
  await gotoLesson(page);
  await selectLesson(page, "l5");

  await composePrompt(page, { description: "run in acceptEdits mode" });
  await runPrompt(page);

  const rail = page.getByTestId("rail");
  await expect(rail).toHaveAttribute("data-mode", "reflecting");
  await expect(rail.getByTestId("quiz-card")).toBeVisible();

  await answerQuiz(page, 0); // "plan mode" is the keyed answer
  await expect(rail).toHaveAttribute("data-mode", "graduated");
  await expect(rail.getByTestId("grade-banner")).toHaveClass(/grade-banner-pass/);
  await expect(rail.getByTestId("rail-next-lesson")).toBeVisible();
});

test("next-lesson affordance advances to completion.next", async ({ page }) => {
  await gotoLesson(page);

  await composePrompt(page, { description: "the vague prompt" });
  await runPrompt(page);

  // The post-grade email capture is the last flow step — skipping it
  // graduates the lesson.
  await page.getByTestId("capture-skip").click();

  const rail = page.getByTestId("rail");
  await expect(rail).toHaveAttribute("data-mode", "graduated");
  await page.getByTestId("rail-next-lesson").click();

  // l1.completion.next is l2.
  await expect(page.locator('[data-testid="lesson-item"][data-lesson-id="l2"]')).toHaveClass(
    /lesson-item-active/,
  );
});
