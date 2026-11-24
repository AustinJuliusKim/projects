#!/usr/bin/env node
// One-off author tool, NOT part of the build. Renders checklist.html to
// public/studio/small-business-tech-checklist.pdf; commit the output.
// Requires Playwright with chromium to be available (it is not a project
// dependency). If `import "playwright"` fails, run with
//   NODE_PATH="$(npm root -g)" node scripts/checklist/render-pdf.mjs
// (resolved below via createRequire against that path).
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  const globalRoot = execSync("npm root -g").toString().trim();
  const req = createRequire(join(globalRoot, "noop.js"));
  ({ chromium } = req("playwright"));
}

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "public", "studio", "small-business-tech-checklist.pdf");
await mkdir(dirname(out), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(join(here, "checklist.html")).href);
await page.pdf({ path: out, format: "Letter", printBackground: true, preferCSSPageSize: true });
await browser.close();
console.log(`wrote ${out}`);
