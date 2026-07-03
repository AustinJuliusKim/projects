/**
 * Recipe registry: recording instructions for lessons 2-8 (content spec —
 * prompts, quiz, assertions — stays in lessons.json). Chain order matches
 * the plan's snapshot chain: l1 -> l3 -> l4 -> l5 -> l6 -> l7 -> l8, with l2
 * merged from l1's own recording (no live run, not part of the output chain).
 */

import { recipe as l2 } from "./l2.js";
import { recipe as l3 } from "./l3.js";
import { recipe as l4 } from "./l4.js";
import { recipe as l5 } from "./l5.js";
import { recipe as l6 } from "./l6.js";
import { recipe as l7 } from "./l7.js";
import { recipe as l8 } from "./l8.js";

export const recipes = { l2, l3, l4, l5, l6, l7, l8 };

/** Recording/chain order for `seed-lessons all` (l1 is handled separately). */
export const CHAIN_ORDER = ["l2", "l3", "l4", "l5", "l6", "l7", "l8"];
