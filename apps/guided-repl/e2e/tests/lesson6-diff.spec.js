import { test, expect } from "@playwright/test";
import { gotoLesson, selectLesson, composePrompt, runPrompt, waitForDone } from "../helpers.js";


test("l6 planted-bug branch: the check catches the bug", async ({ page }) => {
  await gotoLesson(page);
  await selectLesson(page, "l6");

  await composePrompt(page, { description: "the change with a planted bug" });
  await runPrompt(page);
  const banner = await waitForDone(page);
  await expect(banner).not.toHaveClass(/grade-banner-pass/);
});

test("l6 clean branch: the check passes", async ({ page }) => {
  await gotoLesson(page);
  await selectLesson(page, "l6");

  await composePrompt(page, { description: "the clean change" });
  await runPrompt(page);
  const banner = await waitForDone(page);
  await expect(banner).toHaveClass(/grade-banner-pass/);
});
