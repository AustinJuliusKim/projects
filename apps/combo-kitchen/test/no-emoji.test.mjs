// House rule: this game never uses emoji or unicode picture-glyphs as
// graphics — everything visual is 8-bit pixel art from src/sprites/data.ts.
// This test keeps the rule enforced: it fails on any emoji, pictograph,
// dingbat, arrow, or variation selector anywhere in src/ or index.html.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

const BANNED = new RegExp(
  [
    "[\\u{1F000}-\\u{1FAFF}]", // emoji, pictographs, symbols
    "[\\u{2600}-\\u{27BF}]", // misc symbols + dingbats (incl. stars)
    "[\\u{2B00}-\\u{2BFF}]", // misc symbols and arrows
    "[\\u{2190}-\\u{21FF}]", // arrows
    "[\\u{FE00}-\\u{FE0F}]", // variation selectors
    "[\\u{1F1E6}-\\u{1F1FF}]", // regional indicators
  ].join("|"),
  "u",
);

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(path));
    else out.push(path);
  }
  return out;
}

test("no emoji or picture-glyph shortcuts anywhere in src/ or index.html", () => {
  const files = [...collectFiles(join(appRoot, "src")), join(appRoot, "index.html")];
  const offenders = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const match = content.match(BANNED);
    if (match) {
      const line = content.slice(0, match.index).split("\n").length;
      offenders.push(`${relative(appRoot, file)}:${line} contains "${match[0]}"`);
    }
  }
  assert.deepEqual(offenders, [], `emoji found — draw a sprite instead:\n${offenders.join("\n")}`);
});
