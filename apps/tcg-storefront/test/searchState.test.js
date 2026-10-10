import assert from "node:assert/strict";
import { test } from "node:test";

import {
  emptyState,
  FACET_NAMES,
  hasCriteria,
  pageCount,
  parseSearchParams,
  patchState,
  searchHref,
  shouldSuggest,
  toRequestParams,
  toSearchParams,
} from "../src/searchState.js";

test("facet names mirror tcg_search build.facet_names", () => {
  assert.deepEqual(FACET_NAMES.catalog, [
    "set", "rarity", "finish", "price", "colors", "identity", "types", "keywords", "format",
  ]);
  assert.deepEqual(FACET_NAMES.stock, [
    "set", "rarity", "finish", "condition", "price", "colors", "identity", "types", "keywords",
    "format",
  ]);
});

test("empty URL is the default state", () => {
  assert.deepEqual(parseSearchParams(""), emptyState());
  assert.equal(toSearchParams(emptyState()).toString(), "");
});

test("parses repeated facet params, dedupes, ignores unknowns", () => {
  const s = parseSearchParams(
    "q=+t%3Adragon+c%3Ar+&mode=catalog&sort=price_asc&page=3&page_size=48" +
      "&set=lea&set=leb&set=lea&colors=R&colors=&bogus=1&condition=NM",
  );
  assert.deepEqual(s, {
    q: "t:dragon c:r",
    mode: "catalog",
    sort: "price_asc",
    page: 3,
    pageSize: 48,
    facets: { set: ["lea", "leb"], colors: ["R"], condition: ["NM"] },
  });
});

test("bad values fall back to defaults", () => {
  const s = parseSearchParams("mode=nope&sort=random&page=-2&page_size=abc");
  assert.equal(s.mode, "stock");
  assert.equal(s.sort, "relevance");
  assert.equal(s.page, 1);
  assert.equal(s.pageSize, 24);
  assert.equal(parseSearchParams("page_size=500").pageSize, 100);
  assert.equal(parseSearchParams("page=1.5").page, 1);
});

test("URL round-trips and omits defaults", () => {
  const url = "q=bolt&mode=catalog&sort=newest&page=2&set=lea&set=leb&price=100-500";
  const s = parseSearchParams(url);
  assert.equal(toSearchParams(s).toString(), url);
  assert.deepEqual(parseSearchParams(toSearchParams(s)), s);
});

test("API request always carries mode and page_size, repeats facets", () => {
  const s = parseSearchParams("q=bolt&colors=R&colors=G&page=2");
  assert.deepEqual(toRequestParams(s), [
    ["q", "bolt"],
    ["mode", "stock"],
    ["page", "2"],
    ["page_size", "24"],
    ["colors", "R"],
    ["colors", "G"],
  ]);
});

test("catalog requests drop the listings-only condition facet", () => {
  const s = parseSearchParams("mode=catalog&condition=NM&set=lea");
  assert.deepEqual(toRequestParams(s), [
    ["mode", "catalog"],
    ["page_size", "24"],
    ["set", "lea"],
  ]);
});

test("patchState resets paging and prunes facets on mode switch", () => {
  const s = parseSearchParams("q=x&page=4&condition=NM&set=lea");
  assert.equal(patchState(s, { sort: "name" }).page, 1);
  assert.equal(patchState(s, { page: 5 }).page, 5);
  const cat = patchState(s, { mode: "catalog" });
  assert.deepEqual(cat.facets, { set: ["lea"] });
  assert.equal(cat.page, 1);
});

test("searchHref", () => {
  assert.equal(searchHref("demo", emptyState()), "/s/demo/search");
  assert.equal(
    searchHref("demo", { ...emptyState(), q: "sol ring" }),
    "/s/demo/search?q=sol+ring",
  );
});

test("pageCount respects the server's result window", () => {
  assert.equal(pageCount(0, 24), 1);
  assert.equal(pageCount(25, 24), 2);
  assert.equal(pageCount(100000, 24), 100);
  assert.equal(pageCount(100000, 96), 25);
});

test("hasCriteria", () => {
  assert.equal(hasCriteria(emptyState()), false);
  assert.equal(hasCriteria({ ...emptyState(), q: "x" }), true);
  assert.equal(hasCriteria({ ...emptyState(), facets: { set: ["lea"] } }), true);
});

test("shouldSuggest only for plain name-like text", () => {
  for (const ok of ["li", "lightning bo", "lim-dul", "jace, the"]) {
    assert.equal(shouldSuggest(ok), true, ok);
  }
  for (const no of ["", " l ", "t:dragon", "mv<=3", "-goblin", "bolt -t:instant", '"draw a', "x".repeat(101)]) {
    assert.equal(shouldSuggest(no), false, no);
  }
});
