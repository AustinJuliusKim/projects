import { test, expect } from "@playwright/test";
import { gotoLesson, pickChoices, runPrompt, waitForDone } from "../helpers.js";

test("unmatched choice combination shows a hint, not an error or a run", async ({
  page,
}) => {
  await gotoLesson(page);

  // 2x2x2 = 8 combinations; only 3 are recorded branches. This one is not.
  await pickChoices(page, {
    task: "make a page",
    subject: "for my photography",
    constraint: "single index.html file, inline CSS",
  });
  await runPrompt(page);

  await expect(page.getByTestId("hint")).toBeVisible();
  // No replay started: no grade banner, and Run stays enabled for a retry.
  await expect(page.getByTestId("grade-banner")).not.toBeVisible();
  await expect(page.getByTestId("run-button")).toBeEnabled();
});

test("after a hint, a corrected combination runs and grades pass", async ({ page }) => {
  await gotoLesson(page);

  await pickChoices(page, {
    task: "make a page",
    subject: "for my photography",
    constraint: "single index.html file, inline CSS",
  });
  await runPrompt(page);
  await expect(page.getByTestId("hint")).toBeVisible();

  // Correct to the constrained branch and re-run: hint clears on submit.
  await pickChoices(page, { subject: "about me", task: "make a personal landing page" });
  await runPrompt(page);
  await expect(page.getByTestId("hint")).not.toBeVisible();

  const banner = await waitForDone(page);
  await expect(banner).toHaveClass(/grade-banner-pass/);
});
