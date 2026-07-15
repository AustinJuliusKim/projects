import { test, expect } from "@playwright/test";

// Mobile shell (≤768px): the lesson spine becomes a full-screen sessions-style
// list; the terminal/chat is one primary scroll with a pinned composer and
// Files / Lesson / overflow surfaced as bottom sheets. These specs run at an
// iPhone-class viewport (overriding the suite's Desktop Chrome project) and,
// like the rest, drive instant replay via /?speed=0.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** Open the app on the mobile lessons list. */
async function gotoLessons(page) {
  await page.goto("/?speed=0");
  await expect(page.getByTestId("m-lessons-screen")).toBeVisible();
}

/** Drill into a lesson from the list → the session screen. */
async function enterFirstLesson(page) {
  await page.getByTestId("lesson-item").first().click();
  await expect(page.getByTestId("m-session-screen")).toBeVisible();
  await expect(page.getByTestId("composer-input")).toBeVisible();
}

test("lessons list drills into a session and back", async ({ page }) => {
  await gotoLessons(page);
  await expect(page.getByTestId("lesson-item").first()).toBeVisible();

  await enterFirstLesson(page);
  // Header shows back + overflow, composer has the circular send button.
  await expect(page.getByTestId("m-back")).toBeVisible();
  await expect(page.getByTestId("m-menu-trigger")).toBeVisible();
  await expect(page.getByTestId("run-button")).toBeVisible();

  await page.getByTestId("m-back").click();
  await expect(page.getByTestId("m-lessons-screen")).toBeVisible();
});

test("Files pill opens the workspace as a bottom sheet", async ({ page }) => {
  await gotoLessons(page);
  await enterFirstLesson(page);

  await page.getByTestId("m-open-files").click();
  await expect(page.getByTestId("m-sheet-files")).toBeVisible();
  await expect(page.getByTestId("workspace")).toBeVisible();

  await page.getByTestId("m-sheet-close").click();
  await expect(page.getByTestId("m-sheet-files")).toHaveCount(0);
});

test("Lesson bar opens the instruction + Continue in a sheet", async ({ page }) => {
  await gotoLessons(page);
  await enterFirstLesson(page);

  await page.getByTestId("m-lesson-bar").click();
  await expect(page.getByTestId("m-sheet-lesson")).toBeVisible();
  await expect(page.getByTestId("rail-instruction")).toBeVisible();
  await expect(page.getByTestId("rail-continue")).toBeVisible();
});

test("overflow menu returns to the lessons list", async ({ page }) => {
  await gotoLessons(page);
  await enterFirstLesson(page);

  await page.getByTestId("m-menu-trigger").click();
  await expect(page.getByTestId("m-sheet-menu")).toBeVisible();
  await expect(page.getByTestId("m-menu-restart")).toBeVisible();

  await page.getByTestId("m-menu-lessons").click();
  await expect(page.getByTestId("m-lessons-screen")).toBeVisible();
});

test("a run writes a file reachable via its transcript chip", async ({ page }) => {
  await gotoLessons(page);
  await enterFirstLesson(page);

  // Compose the first suggested prompt and run it (instant replay).
  await page.getByTestId("composer-input").click();
  await page.getByTestId("composer-option").first().click();
  await page.getByTestId("run-button").click();

  // A file-writing tool row exposes the "open in Files" chip.
  const chip = page.getByTestId("transcript-open-file").first();
  await expect(chip).toBeVisible();

  // An interactive lesson moment may auto-open the lesson sheet; close it.
  const close = page.getByTestId("m-sheet-close");
  if (await close.count()) await close.first().click();

  await chip.click();
  await expect(page.getByTestId("m-sheet-files")).toBeVisible();
  await expect(page.getByTestId("workspace")).toBeVisible();
});
