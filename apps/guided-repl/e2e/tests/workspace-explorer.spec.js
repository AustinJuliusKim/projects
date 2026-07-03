import { test, expect } from "@playwright/test";
import { gotoLesson, pickChoices, runPrompt, waitForDone, fileBadge, openFile } from "../helpers.js";

test("l1 run: new-file badge on index.html, diff view on open", async ({ page }) => {
  await gotoLesson(page);
  await pickChoices(page, {
    task: "make a personal landing page",
    subject: "about me",
    constraint: "single index.html file, inline CSS",
  });
  await runPrompt(page);
  await waitForDone(page);

  await expect(fileBadge(page, "index.html")).toHaveText("new");
  await openFile(page, "index.html");
  await expect(page.getByTestId("diff-viewer")).toBeVisible();

  // Active file-node background is preserved on hover (not masked by :hover pseudo-class).
  const fileNode = page.locator(".file-node-active");
  await fileNode.hover();
  await expect(fileNode).toHaveCSS("background-color", "rgb(232, 132, 92)");
});
