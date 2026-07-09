import { test, expect } from "@playwright/test";
import { gotoLesson, selectLesson } from "../helpers.js";

test("rail lists 8 unlocked lessons and switches between them", async ({ page }) => {
  await gotoLesson(page);

  const items = page.getByTestId("lesson-item");
  await expect(items).toHaveCount(8);
  await expect(page.getByTestId("lesson-rail").locator(".lesson-item-locked")).toHaveCount(0);

  await selectLesson(page, "l3");
  await page.getByTestId("composer-input").click();
  await expect(page.getByTestId("composer-menu")).toContainText("restyle the page");

  await selectLesson(page, "l1");
  await page.getByTestId("composer-input").click();
  await expect(page.getByTestId("composer-menu")).toContainText("make a page");
});
