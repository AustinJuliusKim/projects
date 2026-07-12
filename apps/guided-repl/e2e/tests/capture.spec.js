import { test, expect } from "@playwright/test";
import { gotoLesson, composePrompt, runPrompt, waitForDone, openFile } from "../helpers.js";

// Staged lead capture (Accounts & Progress Spec): name @ L1 intro, email @
// the post-grade save moment. Fixtures carry {{userName}} tokens that the
// player substitutes at render time; capture never gates completion, and
// the whole flow runs with NO backend.

/** Advance from intro to the capture-name card. */
async function gotoNameCapture(page) {
  await gotoLesson(page);
  await page.getByTestId("rail-continue").click();
  await expect(page.getByTestId("capture-card")).toBeVisible();
}

/** Run the constrained branch and wait for the grade banner. */
async function runConstrained(page) {
  await composePrompt(page, { description: "a constrained prompt" });
  await runPrompt(page);
  const banner = await waitForDone(page);
  await expect(banner).toHaveClass(/grade-banner-pass/);
}

test("captured name personalizes the preview <h1>", async ({ page }) => {
  await gotoNameCapture(page);

  await page.getByTestId("capture-name-input").fill("Ada");
  await page.getByTestId("capture-submit").click();

  await runConstrained(page);
  await openFile(page, "index.html");
  await page.getByTestId("preview-toggle").click();
  const srcdoc = await page.getByTestId("preview-frame").getAttribute("srcdoc");
  expect(srcdoc).toContain("<h1>Ada</h1>");
  expect(srcdoc).not.toContain("{{userName}}");
});

test("invalid name is rejected inline and never submitted", async ({ page }) => {
  await gotoNameCapture(page);

  await page.getByTestId("capture-name-input").fill("<img onerror=x>");
  await page.getByTestId("capture-submit").click();

  await expect(page.getByTestId("capture-error")).toContainText(
    "letters, numbers, spaces, . ' - only (30 max)",
  );
  // The card is still open — nothing was recorded.
  await expect(page.getByTestId("capture-card")).toBeVisible();
});

test("skipping the name capture renders the Demo User default", async ({ page }) => {
  await gotoNameCapture(page);

  await page.getByTestId("capture-skip").click();
  await expect(page.getByTestId("capture-card")).toHaveCount(0);

  await runConstrained(page);
  await openFile(page, "index.html");
  await page.getByTestId("preview-toggle").click();
  const srcdoc = await page.getByTestId("preview-frame").getAttribute("srcdoc");
  expect(srcdoc).toContain("<h1>Demo User</h1>");
});

test("email capture appears post-grade with consent unchecked; skip graduates", async ({ page }) => {
  await gotoLesson(page);

  // Compose straight from the intro step — the composer's jump-to-run skips
  // the optional name capture entirely.
  await runConstrained(page);

  // The post-grade email card renders beside the passing banner.
  const card = page.getByTestId("capture-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("capture-email-input")).toBeVisible();
  // Consent must NEVER be pre-checked.
  await expect(page.getByTestId("capture-consent")).not.toBeChecked();

  await page.getByTestId("capture-skip").click();
  const rail = page.getByTestId("rail");
  await expect(rail).toHaveAttribute("data-mode", "graduated");
  await expect(page.getByTestId("rail-next-lesson")).toBeVisible();
});
