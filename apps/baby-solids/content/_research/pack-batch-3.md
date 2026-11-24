# Research pack — batch 3: the four uncovered allergens

Retrieved 2026-08-06. Primary sources only; no competitor site consulted.

**Retrieval limits:** cdc.gov 403s and web.archive.org was unreachable, so CDC
text is from live search indexing of cdc.gov (flagged ⚠️). fda.gov 404s to
direct fetch; FDA text is from domain-restricted search indexing (⚠️). USDA's
search API returned `OVER_RATE_LIMIT`, so several `fdcId`s could not be
surfaced and are marked unverified rather than guessed.

## 🚩 The headline finding: the 1:3 dilution ratio is issued by nobody

This batch was commissioned partly to source the nut-butter thinning rule. It
has no source.

- **AAP issues a qualitative rule only:** "Thick chunks of peanut butter or
  other nut butters (be sure to **spread thinly** instead)."
  <https://www.healthychildren.org/English/health-issues/injuries-emergencies/pages/Choking-Prevention.aspx>
- **CDC names the hazard, issues no fix:** "Chunks or spoonful of nut and seed
  butters." Note "**seed** butters" — tahini is inside the hazard entry, not
  adjacent to it.
- **NIAID issues the only numeric preparation in US guidance, and it is
  peanut-only:** "Measure 2 teaspoons of peanut butter and slowly add **2 to 3
  teaspoons of hot water**" — roughly **1:1 to 1:1.5**, not 1:3 — as part of an
  allergy-prevention dosing protocol, not a general choking rule.
  <https://www.niaid.nih.gov/sites/default/files/addendum_guidelines_peanut_appx_d.pdf>
  (via PMC5217343)

**So a "1:3" figure applied to almond, cashew or tahini is doubly extrapolated —
wrong ratio, wrong food.** Publish the method, not a borrowed number: thin until
it no longer holds its shape / pours off a spoon. That is what "spread thinly"
actually supports.

## NIAID's two hard age floors — stricter than AAP's

> "Whole nuts should not be given to children **less than 5 years** of age.
> Peanut butter directly from a spoon or in lumps/dollops should not be given to
> children **less than 4 years** of age."

AAP's general framing is "until 4 years of age or older." NIAID's 5-year floor
for whole nuts is stricter and is the cautious default.

## The mollusc trap — confirmed against FDA

> "Crustacean shellfish and ingredients that contain protein derived from
> crustacean shellfish are major food allergens, but **molluscan shellfish (such
> as oysters, clams, mussels, or scallops) are not**."
> <https://www.fda.gov/food/nutrition-food-labeling-and-critical-foods/food-allergies> ⚠️

Shrimp, crab, lobster, crawfish = major allergen, must be label-declared.
Oyster, mussel, clam, scallop = **not** major allergens, not subject to
mandatory declaration — though a mollusc allergy is real and can be severe.
Say both halves; consumer intuition, menus and most parenting advice treat
"shellfish" as one category and FDA does not.

**Batch-3 consequence: shrimp and crab close the crustacean slot. No mollusc
closes it.**

## Sesame — the ninth allergen

FASTER Act signed **2021-04-23**, effective **2023-01-01**. Pre-2023 packaging
and pre-2023 parenting advice both predate mandatory sesame declaration.
<https://www.fda.gov/food/food-allergies/faster-act-sesame-ninth-major-food-allergen> ⚠️

## Tree nut is not one allergen

Almond and cashew are separate sensitizations; tolerating one says nothing
about the other. Reported clustering: **cashew–pistachio**, **hazelnut–walnut**.
Almond does not cluster with cashew.

**NIAID's addendum covers peanut only** — do not badge almond, cashew or walnut
guidance as NIAID. **No US body issues a multi-tree-nut introduction protocol**;
the number of nuts, the order and the interval are all unverified. AAAAI's 2022
Ask-the-Expert is explicitly provisional ("a paucity of information with regard
to tree nuts") and defers to the TreEat trial — **check whether TreEat has
reported; if so this section is stale.**

## Wheat, gluten and celiac are three different things

Wheat is one of the nine. **Barley and rye are gluten but are not major
allergens.** "Gluten-free" and "wheat-free" are not the same claim. NIDDK: wheat
allergy "does not cause long-term damage to the small intestine"; celiac is not
an IgE allergy and is not governed by allergen-introduction timing.

## Fish scope gap, again

All three batch-3 seafoods (shrimp, crab, sardine) are FDA/EPA **Best Choices**.
But **the advice is scoped to ages 1–11** and serving amounts start at "1 to 3
years old should eat 1 ounce per serving." **No FDA/EPA amount exists below 12
months.** Same structural gap batch 1 found for salmon — it is not
salmon-specific.

---

## Per food

### Shrimp
US-9 **crustacean** ✅. NHS hard rule: "shellfish (do not serve raw or lightly
cooked)." Shell and tail off before cooking; ≤½ in (AAP). ⚠️ No body names
shrimp on a choking list — the modification applies CDC's general rules, badge
as inference. Fe **0.51 mg**, Zn 1.64, Na 111, protein 24.0 · `fdcId` **175180**
✅. **Shrimp is not an iron food** — its value is allergen coverage and protein.

### Lump crabmeat
US-9 **crustacean**. Never raw or lightly cooked (NHS). 🚩 **The shell fragment
is the hazard, not the meat** — pasteurized lump crab routinely carries shell
and cartilage shards; pick over by hand under good light every time. Sodium:
typically packed with salt, figure **unverified**. **`fdcId` unverified** — four
probed ids returned other foods. **Publish no iron figure; do not borrow
shrimp's.** Do not substitute imitation crab — it is surimi plus starch, wheat
and salt, changes the allergen profile, and does not close the crustacean slot.

### Almond butter
US-9 **tree nut**. 🚩 Direct hazard-list entry — AAP's rule is written for
"other nut butters," so it binds almond butter directly. Smooth only, never
crunchy. Never off a spoon (NIAID mechanism, peanut-scoped → `expert_opinion`
here). ⚠️ **`fdcId` for the butter is unverified.** Proxy only, clearly labelled:
whole almonds Fe **3.71**, Zn 3.12, Na 1 · `fdcId` **170567**. A butter figure
carried on a whole-nut id is a fabrication — grinding changes moisture and
therefore per-100 g density.

### Cashew butter
US-9 **tree nut**, distinct from almond; clusters with pistachio. Same hazard
entry and same modification. ⚠️ **Butter `fdcId` unverified.** Proxy: dry-roasted
cashews Fe **6.00**, Zn 5.60 · `fdcId` **170571**. Cashews are never truly raw —
"raw" retail cashews are steamed, since the shell oil is caustic. Not a safety
issue; pre-empts a parent question.

### Ground walnut
US-9 **tree nut**, third distinct sensitization; clusters with hazelnut.
🚨 **Highest-flag item among the nuts** — on both hazard lists. CDC: "whole or
**chopped** nuts and seeds." NIAID: whole nuts **<5 years**.
**NHS issues the only sanctioned form: "serve them finely ground."**
**Chopped is explicitly a hazard, not merely discouraged** — say this loudly,
because "chopped fine" reads as safe to a parent. Finely ground and stirred into
a moist food at *every* band; no band gets a walnut piece. Fe **2.91** non-heme
· `fdcId` **170187** ✅ — and this is the exact food, since ground walnut is
whole walnut ground.

### Tahini
US-9 **sesame** ✅ — the highest-protein-density, lowest-choking-risk sesame
vehicle. 🚩 Inside CDC's "seed butters" hazard entry. Runnier than nut butters
and separates: stir the jar thoroughly, then thin further — the separated oil
layer is not a substitute for thinning. NHS on the seed form: "serve seeds
finely ground."
⚠️ **Tahini `fdcId` unverified.** Verified proxies, all whole/kernel sesame:
whole seeds Fe **14.6**, Ca 975 · `fdcId` **170150**; roasted whole Fe 14.8, Ca
989 · **170151**; **hulled kernels Fe 7.78, Ca 131** · **170152**.
🔎 **Decortication effect, USDA-verified and editorially important:** hulled
kernels lose ~87% of the calcium (989→131) and ~47% of the iron (14.8→7.78)
versus whole seeds. Most commercial tahini is made from hulled kernels, so
tahini tracks the kernel row — **but the tahini value itself is unverified;
publish no number.**

### Toasted sesame oil
US-9 **sesame** — ⚠️ **but do not use oil to close the sesame slot.** Refined
oils are generally low in allergenic protein, unrefined/toasted are variable,
and **no body sanctions oil as an allergen-introduction vehicle.** Use tahini or
ground sesame for introduction; the oil is flavour only. No choking risk.
**`fdcId` and iron unverified.** Finishing oil, low smoke point, few drops.
Quantity guidance for infants: unverified.

### Whole-wheat toast strips
US-9 **wheat** ✅. Bread is on neither hazard list by name, but soft fresh bread
balls up in the mouth; toasting is the standard mitigation — ⚠️ **issued by no
body**, `common_practice`. Strip shape supported by NHS's "narrow batons" and
CDC's cylindrical principle. AAP's ≤½ in applies to *width*.
🚩 **Sodium is the real problem.** Wheat bread Na **473 mg/100 g** · `fdcId`
**172686**; **toasted Na 601 mg/100 g, Fe 4.09** · `fdcId` **172687** — toasting
drives off water and concentrates everything ~27%. **601 mg/100 g in a food
marketed as a first finger food deserves a second look.** Prefer a low- or
no-salt loaf. ⚠️ Both ids are "Bread, wheat", **not** whole-wheat — label them as
such. Iron is largely from enrichment, not the grain.

### Wheat pasta
US-9 **wheat**, and ⚠️ **frequently contains egg** (fresh/"egg noodle") — a
second US-9 allergen arriving unannounced. Check the label. Cook **well past al
dente** to fork-mashable (CDC). Short shapes beat long strands (CDC's
cylindrical rule). Whole-grain cooked Fe **1.65**, **Na 6 mg** · `fdcId`
**168916** ✅. **Pasta is the low-sodium wheat vehicle; bread is not.** Enriched
pasta is meaningfully higher in iron but its `fdcId` is unverified — publish no
enriched figure. No salt in the cooking water for infant portions.

### Semolina upma (सूजी)
US-9 **wheat**. ⚠️ **Traditional tempering adds mustard seed, curry leaf,
urad/chana dal, cashew and sometimes peanut** — potentially three more US-9
allergens plus mustard (an allergen in the UK/EU, not in the US 9). For a first
wheat exposure, temper plainly or omit it.
🚩 **The tempering is the choking hazard, not the porridge** — whole mustard
seeds and cashew halves are both inside CDC's "whole or chopped nuts and seeds"
entry. Omit or grind in. Cook smooth and thin (CDC). **Omit salt entirely.**
❌ **`fdcId` unverified** — and enriched vs unenriched semolina differ enormously
in iron, so the gap materially changes the food's story. Publish no figure.

### Canned no-salt-added sardines
US-9 **fish** (already covered by salmon; sardines add iron and calcium, not new
coverage). **Mercury: Best Choices** — among the safest fish available.
🚩 **The one food where guideline and practice genuinely diverge.** CDC issues
"remove all fat, skin and **bones** from poultry, meat and fish before cooking."
Canned sardines are sold **bones-in by design** — pressure-cooked until soft and
crushable, and that is the entire nutritional point (Ca **382 mg/100 g**).
**No US body issues an exception for softened canned bones.** Serving sardines
bones-in is a `common_practice` departure from a `guideline` and must be
labelled as one, not presented as sanctioned. Cautious default: mash thoroughly
so no intact segment remains, and inspect for the spine, the one bone that can
stay firm.
Fe **2.92 mg — heme, the highest in this batch** and well above salmon's 1.03.
Na **307 mg/100 g** · `fdcId` **175139** — ⚠️ **that is the salted pack.** A
no-salt-added `fdcId` is unverified; do not present 307 mg as the no-salt value.
The sodium is the *only* reason to specify pack type — nutrition is otherwise
identical.

---

## Unverified register — do not invent these

1. `fdcId` and all composition for **lump crabmeat, semolina, toasted sesame oil**.
2. `fdcId` for **the butters themselves** — almond, cashew, tahini. Only whole-nut and whole-seed proxies verified.
3. `fdcId` for a genuinely **whole-wheat** bread (172686/172687 are "Bread, wheat").
4. `fdcId` for a **no-salt-added sardine** pack.
5. `fdcId` for **enriched pasta** — where pasta's iron actually comes from.
6. **Any dilution ratio other than NIAID's peanut-specific 2 tsp : 2–3 tsp hot water.**
7. **Any tree-nut or sesame protein dose for allergy prevention** — NIAID's 2 g/feeding and 6–7 g/week are peanut-only.
8. **Any seafood serving amount below 12 months.**
9. **Infant sodium limit in mg/day** — not verified in this batch.
10. **Number of tree nuts needed to "cover" the tree-nut allergen, and any order or interval.**
11. Quantity guidance for toasted sesame oil.
12. **Shrimp, crab, bread and pasta as named entries on any official choking list** — none are named; all modifications are applications of CDC's general rules.
13. **"Toast rather than serve fresh bread"** — sound practice, issued by no body.

## Disagreements to surface, not resolve

- **Whole-nut age floor:** NIAID **<5 years** vs AAP's "until 4 years or older." NIAID is the cautious default; both are live.
- **Sardine bones:** CDC says remove all bones; the entire canned-sardine category depends on softened bones-in for its calcium. A genuine guideline-vs-practice conflict, not an oversight.
- **"Shellfish" as a category:** FDA splits crustacean from mollusc; consumers, menus and most parenting advice do not.
- **Wheat vs gluten:** the US-9 covers wheat only; NHS groups "wheat, barley and rye" for weaning. Both correct, different questions.
- **Tree-nut introduction:** AAAAI notes Australian practice permits cautious home introduction of individual tree nuts without prior testing, and that this is **not** standard US practice.
- **Sesame form:** NHS issues "serve seeds finely ground"; the US has no equivalent form instruction despite sesame now being a major allergen. The gap itself is worth noting.
