import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { nextLessonOrder, withLessonOrder } from "../src/lessons/nextOrder.js";

function tmpLessons(orders) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-orders-"));
  orders.forEach((o, i) => fs.writeFileSync(path.join(dir, `l${i}.yaml`), `id: l${i}\norder: ${o}\n`));
  return dir;
}

test("nextLessonOrder returns max committed order + 1", () => {
  const dir = tmpLessons([1, 2, 8, 3]);
  try {
    assert.equal(nextLessonOrder(dir), 9);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nextLessonOrder is 1 for an empty corpus, ignores non-.yaml files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-orders-"));
  fs.writeFileSync(path.join(dir, "README.md"), "order: 99\n");
  try {
    assert.equal(nextLessonOrder(dir), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nextLessonOrder over the committed corpus is 9 (l1–l8)", () => {
  assert.equal(nextLessonOrder(), 9);
});

test("withLessonOrder rewrites only the top-level order line and syncs doc.order", () => {
  const yamlText = "id: lx\norder: 1\nsteps:\n  - id: intro\n    order: 5\n";
  const { yamlText: out, doc } = withLessonOrder(yamlText, { id: "lx", order: 1 }, 9);
  assert.match(out, /^order: 9$/m);
  assert.doesNotMatch(out, /^order: 1$/m);
  assert.match(out, /^    order: 5$/m, "indented (nested) order untouched");
  assert.equal(doc.order, 9);
});

test("withLessonOrder preserves a trailing comment", () => {
  const { yamlText } = withLessonOrder("order: 1  # exemplar\n", { order: 1 }, 12);
  assert.match(yamlText, /^order: 12  # exemplar$/m);
});

test("withLessonOrder throws when there is no top-level order line", () => {
  assert.throws(() => withLessonOrder("id: lx\ntitle: T\n", { id: "lx" }, 9), /no top-level `order:` line/);
});
