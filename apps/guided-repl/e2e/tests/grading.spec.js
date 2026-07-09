import { test, expect } from "@playwright/test";
import { gotoLesson, composerInput, composePrompt, runPrompt, waitForDone } from "../helpers.js";

test("Enter on unmatched text shows a hint, not an error or a run", async ({ page }) => {
  await gotoLesson(page);

  // Free text that matches no suggestion: Run stays disabled and Enter
  // raises the hint instead of starting a replay.
  const input = composerInput(page);
  await input.fill("make a page for my photography, single index.html file, inline CSS");
  await expect(page.getByTestId("run-button")).toBeDisabled();
  await input.press("Escape");
  await input.press("Enter");

  await expect(page.getByTestId("hint")).toBeVisible();
  await expect(page.getByTestId("grade-banner")).not.toBeVisible();
});

test("after a hint, a corrected prompt runs and grades pass", async ({ page }) => {
  await gotoLesson(page);

  const input = composerInput(page);
  await input.fill("make a page for my photography");
  await input.press("Escape");
  await input.press("Enter");
  await expect(page.getByTestId("hint")).toBeVisible();

  // Correct via the menu and re-run: hint clears on a successful submit.
  await composePrompt(page, { description: "a constrained prompt" });
  await runPrompt(page);
  await expect(page.getByTestId("hint")).not.toBeVisible();

  const banner = await waitForDone(page);
  await expect(banner).toHaveClass(/grade-banner-pass/);
});
