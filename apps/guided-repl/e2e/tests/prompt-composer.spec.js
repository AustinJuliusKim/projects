import { test, expect } from "@playwright/test";
import { gotoLesson, composerInput, composePrompt, runPrompt, waitForDone, selectLesson } from "../helpers.js";

// The composer replaces the segmented prompt builder: suggestions are the
// lesson's branch prompts, only a completed match can run, and picking a
// menu option carries an explicit branchId (the disambiguator for lessons
// whose branches share identical prompt text).

const VAGUE = "make a page about me, in index.html";

test("shows a ghost placeholder and opens the menu on focus", async ({ page }) => {
  await gotoLesson(page);
  const input = composerInput(page);
  await expect(input).toHaveAttribute("placeholder", /Try typing/);
  await input.click();
  await expect(page.getByTestId("composer-menu")).toBeVisible();
  // All three l1 suggestions show with their descriptions.
  await expect(page.getByTestId("composer-option")).toHaveCount(3);
  await expect(page.getByTestId("composer-menu")).toContainText("the vague prompt");
});

test("typing ranks prefix matches first and drops non-matches", async ({ page }) => {
  await gotoLesson(page);
  // Prefix match ranks the vague prompt first (others may remain as
  // lower-ranked subsequence matches).
  await composerInput(page).fill("make a page");
  const options = page.getByTestId("composer-option");
  await expect(options.first()).toContainText(VAGUE);

  // A non-matching input empties the menu.
  await composerInput(page).fill("zzz qqq");
  await expect(page.getByTestId("composer-menu")).toHaveCount(0);
});

test("run button stays disabled until the input matches a suggestion", async ({ page }) => {
  await gotoLesson(page);
  const run = page.getByTestId("run-button");
  await expect(run).toBeDisabled();
  await composerInput(page).fill("make me a sandwich");
  await expect(run).toBeDisabled();
  await composePrompt(page, { text: VAGUE });
  await expect(run).toBeEnabled();
});

test("keyboard flow: arrows + Tab complete, Enter runs the matched branch", async ({ page }) => {
  await gotoLesson(page);
  const input = composerInput(page);
  // focus() (not click()) — a pointer resting over the opened menu would
  // move the highlight via mouseenter and make arrow-key order flaky.
  await input.focus();
  await input.press("ArrowDown"); // highlight: vague → constrained
  await input.press("Tab");
  await expect(input).toHaveValue(/single index\.html file/);
  await input.press("Enter");
  // The submitted prompt is echoed as a user row in the transcript.
  await expect(page.getByTestId("transcript")).toContainText("make a");
  await waitForDone(page);
});

test("Enter on unmatched text shows the hint and does not run", async ({ page }) => {
  await gotoLesson(page);
  const input = composerInput(page);
  await input.fill("do something completely different");
  await input.press("Escape"); // menu closed — Enter must not autocomplete
  await input.press("Enter");
  await expect(page.getByTestId("hint")).toBeVisible();
  await expect(page.getByTestId("transcript")).not.toContainText("do something completely different");
});

test("duplicate-prompt lesson: menu descriptions select distinct branches", async ({ page }) => {
  await gotoLesson(page);
  await selectLesson(page, "l5");

  // All three l5 branches share the same prompt text; the acceptEdits branch
  // is only reachable via its menu description (explicit branchId).
  await composePrompt(page, { description: "run in acceptEdits mode" });
  await runPrompt(page);

  // The acceptEdits fixture has no permission gate — it must play straight
  // through to done without the modal appearing.
  await expect(page.getByTestId("permission-modal")).toHaveCount(0);
  await expect(page.getByTestId("quiz-card")).toBeVisible();
});
