import { test, expect } from "@playwright/test";
import { gotoLesson, composePrompt, runPrompt, waitForDone, fileTreeEntry, openFile } from "../helpers.js";

// Golden path for the L1 "constrained" branch: compose the exact expected
// prompt via the composer menu, run it, and verify the replay grades pass
// and reconstructs index.html.
const EXPECTED_PROMPT =
  "make a personal landing page about me, single index.html file, inline CSS";

test("constrained branch golden path", async ({ page }) => {
  await gotoLesson(page);

  await composePrompt(page, { description: "a constrained prompt" });
  await expect(page.getByTestId("composer-input")).toHaveValue(EXPECTED_PROMPT);

  await runPrompt(page);

  const banner = await waitForDone(page);
  await expect(banner).toHaveClass(/grade-banner-pass/);

  await expect(fileTreeEntry(page, "index.html")).toBeVisible();
  await openFile(page, "index.html");
  await expect(page.getByTestId("diff-viewer")).toBeVisible();
});
