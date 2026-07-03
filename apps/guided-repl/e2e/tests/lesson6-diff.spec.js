import { test, expect } from "@playwright/test";
import { gotoLesson, selectLesson, pickChoices, runPrompt, waitForDone } from "../helpers.js";

const TASK = "add a testimonials section to the page";
const SUBJECT = "with two example quotes";
const CLEAN = "style it with a CSS class named .testimonial-card defined in the stylesheet";
const BUG = "reference a CSS class named .testimonial-card in the HTML but do not add a .testimonial-card rule anywhere in the stylesheet";

test("l6 planted-bug branch: the check catches the bug", async ({ page }) => {
  await gotoLesson(page);
  await selectLesson(page, "l6");

  await pickChoices(page, { task: TASK, subject: SUBJECT, constraint: BUG });
  await runPrompt(page);
  const banner = await waitForDone(page);
  await expect(banner).not.toHaveClass(/grade-banner-pass/);
});

test("l6 clean branch: the check passes", async ({ page }) => {
  await gotoLesson(page);
  await selectLesson(page, "l6");

  await pickChoices(page, { task: TASK, subject: SUBJECT, constraint: CLEAN });
  await runPrompt(page);
  const banner = await waitForDone(page);
  await expect(banner).toHaveClass(/grade-banner-pass/);
});
