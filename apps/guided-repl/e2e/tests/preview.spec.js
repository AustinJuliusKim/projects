import { test, expect } from "@playwright/test";
import { gotoLesson, pickChoices, runPrompt, waitForDone, openFile } from "../helpers.js";

// JS component preview ("preview-coming-soon") has no e2e coverage: no
// fixture in this repo writes a .js file, so there is no real file to drive
// the flow with. It's covered structurally in FileViewer.jsx's own logic
// and would need a new fixture to test end-to-end.

test("l1 run: index.html defaults to diff, toggling to preview renders the page", async ({ page }) => {
  await gotoLesson(page);
  await pickChoices(page, {
    task: "make a page",
    subject: "about me",
    constraint: "in index.html",
  });
  await runPrompt(page);
  await waitForDone(page);

  await openFile(page, "index.html");
  // Regression guard: preview must never be the default view.
  await expect(page.getByTestId("diff-viewer")).toBeVisible();

  await page.getByTestId("preview-toggle").click();
  const frame = page.getByTestId("preview-frame");
  await expect(frame).toBeVisible();
  const srcdoc = await frame.getAttribute("srcdoc");
  expect(srcdoc).toContain("<h1");
});

test("l1 run: README.md preview renders markdown to HTML", async ({ page }) => {
  await gotoLesson(page);
  await pickChoices(page, {
    task: "make a page",
    subject: "about me",
    constraint: "in index.html",
  });
  await runPrompt(page);
  await waitForDone(page);

  await openFile(page, "README.md");
  await page.getByTestId("preview-toggle").click();
  const frame = page.getByTestId("preview-frame");
  await expect(frame).toBeVisible();
  const srcdoc = await frame.getAttribute("srcdoc");
  expect(srcdoc).toContain("<h1>My Page</h1>");
});
