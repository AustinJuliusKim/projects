import { test, expect } from "@playwright/test";
import {
  gotoLesson,
  pickChoices,
  promptPreview,
  runPrompt,
  waitForDone,
  fileTreeEntry,
  openFile,
} from "../helpers.js";

// Golden path for the L1 "constrained" branch: build the exact expected prompt,
// run it, and verify the replay grades pass and reconstructs index.html.
const EXPECTED_PROMPT =
  "make a personal landing page about me, single index.html file, inline CSS";

test("constrained branch golden path", async ({ page }) => {
  await gotoLesson(page);

  await pickChoices(page, {
    task: "make a personal landing page",
    subject: "about me",
    constraint: "single index.html file, inline CSS",
  });

  // CLI-styled preview prepends a "> " prompt marker.
  await expect(promptPreview(page)).toHaveText(`> ${EXPECTED_PROMPT}`);

  await runPrompt(page);

  const banner = await waitForDone(page);
  await expect(banner).toHaveClass(/grade-banner-pass/);

  await expect(fileTreeEntry(page, "index.html")).toBeVisible();
  await openFile(page, "index.html");
  await expect(page.getByTestId("diff-viewer")).toBeVisible();
});
