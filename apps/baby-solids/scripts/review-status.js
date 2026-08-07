/**
 * Review queue.
 *
 * Every food record is drafted from primary sources, but drafted is not
 * checked. This prints what still needs a human read, so the review gate is a
 * command you can run rather than a line in a document you have to remember.
 *
 *   node scripts/review-status.js            list unreviewed foods
 *   node scripts/review-status.js --strict   exit non-zero if any are unreviewed
 *
 * --strict is deliberately NOT wired into CI: an unreviewed record is a normal
 * state during authoring, not a broken build. It's there for the moment you
 * want to gate something real on it, like a public deploy.
 */

import { compile } from "./compile-content.js";

function main() {
  const strict = process.argv.includes("--strict");
  const { foods } = compile();
  const unreviewed = foods.filter((f) => !f.reviewedOn);
  const reviewed = foods.length - unreviewed.length;

  console.log(`${reviewed}/${foods.length} food records reviewed.\n`);

  if (unreviewed.length) {
    console.log("Awaiting a human read against their cited sources:");
    for (const f of unreviewed) {
      const allergen = f.allergenProtocol ? "  ← carries an allergen protocol" : "";
      console.log(`  ${f.id.padEnd(22)} ${f.sources.length} source(s)${allergen}`);
    }
    console.log(
      "\nTo mark one reviewed, add `reviewedOn: YYYY-MM-DD` to its frontmatter\n" +
        "and rebuild. Records carrying an allergen protocol are worth reading first —\n" +
        "their medicalGate is the only medical warning in the dataset.",
    );
  }

  if (strict && unreviewed.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
