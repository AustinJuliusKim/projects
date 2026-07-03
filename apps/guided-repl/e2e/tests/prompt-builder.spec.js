import { test, expect } from "@playwright/test";
import { gotoLesson, pickChoices, promptPreview } from "../helpers.js";

// The three branch combinations must assemble to the exact expectedPrompt
// strings in lessons.json — this binding is what fixture matching relies on.
const CASES = [
  {
    name: "vague",
    choices: { task: "make a page", subject: "about me", constraint: "in index.html" },
    expected: "make a page about me, in index.html",
  },
  {
    name: "constrained",
    choices: {
      task: "make a personal landing page",
      subject: "about me",
      constraint: "single index.html file, inline CSS",
    },
    expected:
      "make a personal landing page about me, single index.html file, inline CSS",
  },
  {
    name: "plan-mode",
    choices: {
      task: "make a personal landing page",
      subject: "for my photography",
      constraint: "single index.html file, inline CSS",
    },
    expected:
      "make a personal landing page for my photography, single index.html file, inline CSS",
  },
];

// The preview is rendered CLI-style with a leading "> " prompt marker
// (see PromptBuilder.jsx's cli-input-box), so exact-text assertions must
// include it.

test("defaults assemble to the vague branch prompt", async ({ page }) => {
  await gotoLesson(page);
  await expect(promptPreview(page)).toHaveText("> make a page about me, in index.html");
});

for (const { name, choices, expected } of CASES) {
  test(`assembles the ${name} branch prompt exactly`, async ({ page }) => {
    await gotoLesson(page);
    await pickChoices(page, choices);
    await expect(promptPreview(page)).toHaveText(`> ${expected}`);
  });
}

test("preview updates live as a single choice changes", async ({ page }) => {
  await gotoLesson(page);
  await pickChoices(page, { subject: "for my photography" });
  await expect(promptPreview(page)).toHaveText(
    "> make a page for my photography, in index.html"
  );
  await pickChoices(page, { subject: "about me" });
  await expect(promptPreview(page)).toHaveText("> make a page about me, in index.html");
});
