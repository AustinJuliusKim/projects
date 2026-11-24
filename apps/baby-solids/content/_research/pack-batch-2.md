# Research pack — batch 2

Retrieved 2026-08-06. Primary sources only; no competitor site consulted.
USDA values pulled live from the FDC API; every `fdcId` marked verified was
returned in that session. Two lookups hit the rate limit and are marked
**unverified** rather than guessed.

## Cross-cutting

| Rule | Body |
|---|---|
| Start about 6 months; before 4 months not recommended | CDC (citing DGA + AAP) |
| **"Cut food for infants and young children into pieces no larger than one-half inch"** | AAP |
| High-risk list includes "raw vegetables, such as carrot sticks" and **"raw fruit chunks, such as apple pieces"**; keep from children "until 4 years of age or older" | AAP |
| "Cook hard vegetables and fruits, such as carrots and apples, so you can easily mash or puree them" | CDC |
| "Softening firm fruit and vegetables… by steaming or simmering until soft", then "slices or narrow batons"; for very young children "grating, mashing, steaming or simmering"; "removing the skin… makes it easier to swallow" | NHS |
| Finger food "big enough to hold in their fist with a bit sticking out, pieces about the size of your own finger" | NHS (UK). **No US body issues a stick dimension.** |
| "A pincer grip most often starts between 9 and 10 months" | AAP |
| "Lumpy textures should be offered no later than nine months" | Health Canada |
| No added sugars under 24 months · no juice under 12 months · no honey under 12 months | DGA/CDC · AAP · NHS |
| Iron RDA **11 mg/day at 7–12 months**; vitamin C "enhances the bioavailability of nonheme iron" | NIH ODS |

**Age bands remain editorial.** No US body issues per-food, per-month shape
prescriptions. Anything more specific than AAP's ½ inch or NHS's qualitative
"size of your own finger" is the app's own convention and must be labeled so.

---

## Butternut squash
Age ~6m (NHS names it; CDC names squash at category level). Choking **low
cooked**, modify if raw. Not a US-9 allergen.
Iron negligible and the datasets disagree: `fdcId` **169296** cooked = 0.6 mg
Fe / 15.1 mg C; Foundation **2685570** = 0.213 mg Fe / 7.6 mg C. Treat as a
negligible iron source but a reasonable vitamin-C partner.
On AAP's 2005 list of home-prepared vegetables historically implicated in
methemoglobinemia — see spinach.

## Green peas
Age ~6m (CDC and NHS both name peas). Not a US-9 allergen.
Iron **1.54 mg** cooked, vitamin C 14.2 mg · `fdcId` **170420** (raw **170419**:
1.47 / 40.0). Self-pairing iron + C.
Choking **low once fully cooked**. ⚠️ **Smashing each pea is common practice,
not guideline-issued** — no AAP or CDC document names green peas. AAP's rule is
"do not feed children younger than 4 round, firm food unless it is chopped
completely", and a cooked pea is soft, not firm. Smashing is a conservative
extrapolation; say so plainly rather than implying a rule exists.

## Apple — on AAP's explicit hazard list
🚨 **Raw apple is named by AAP ("raw fruit chunks, such as apple pieces"), CDC
("raw carrots or apples"), and NHS.** AAP keeps it off the menu "until 4 years
of age or older."
**Two guideline-issued fixes:** cook until fork-mashable (CDC/NHS), or **grate
raw** (NHS). Peel either way. NHS also: "cut fruit like melon and apples into
slices instead of small chunks."
Iron essentially none: `fdcId` **171688** raw = 0.12 mg Fe / 4.6 mg C; cooked
without skin **173928** = 0.19 / **0.2** — cooking destroys nearly all the
vitamin C, so cooked apple is *not* a useful C partner.
No juice under 12m; unsweetened applesauce only.

## Pear (European)
**Ripeness decides everything.** Ripe/soft pear: **low** risk — NHS explicitly
permits soft ripe fruit raw. Underripe/hard pear: **treat exactly as raw
apple** — cook or grate, peel either way.
Iron trace: `fdcId` **169118** = 0.18 mg Fe / 4.3 mg C (Bartlett **746773**:
0.17 / 4.4).
Pear is high in sorbitol but **no primary-source guideline** addresses
pear/sorbitol and infant stool — make no claim.

## Mango
Age ~6m as a soft ripe fruit (NHS category level; not individually named by AAP
or CDC — say so). Peel and remove the stone (NHS: "always remove hard pips or
stones"). Low risk ripe and peeled; modify if underripe.
Iron trace, vitamin C strong but **cultivar-dependent by 5×**: `fdcId`
**169910** = 0.16 mg Fe / 36.4 mg C; **2710833** Tommy Atkins = 0.0 / 25.5;
**2710834** Ataulfo = 0.0 / **168**. Report a range, not a point value.
**Urushiol note:** mango peel, leaves and stem contain urushiol-family
compounds cross-reacting with poison ivy, causing type-IV contact dermatitis in
sensitized people (PubMed 15606656; PMC6861053). Peer-reviewed, *not* a
pediatric guideline, and prior sensitization is unlikely in an infant. Serve
peeled flesh only; this is contact dermatitis, not a food allergy.

## Plain whole-milk yogurt — the cow's-milk exception
**Age ~6m, and four bodies concur.** AAP: "Most babies can begin consuming
dairy foods around 6 months of age" and "**plain, whole-fat or whole Greek
yogurt is a good first form of cow's milk protein**". CDC: "yogurt without
added sugars can be introduced before 12 months." NHS: from around 6 months.
Health Canada: 6–9 months.

**Why yogurt is allowed but milk-as-a-drink is not — the mechanism, precisely.**
The prohibition is about *large-volume unmodified* cow's milk displacing
iron-rich food and breast milk/formula. CDC names three properties: intestinal
bleeding risk, too much protein and mineral load for immature kidneys, and the
wrong nutrient profile. AAP adds that cow's-milk protein "can irritate the
lining of the stomach and intestine" and frames the rule around **quantity**.
Yogurt escapes all three: it's eaten in food-sized portions (AAP's own 8–12m
sample menu says **2–4 oz**), doesn't displace the primary milk, and
fermentation partially hydrolyses casein and lactose. It is also the
recommended vehicle for early milk-allergen introduction — so yogurt isn't
merely tolerated before 12 months, it's *preferred*.

⚠️ **Genuine national divergence:** Health Canada permits pasteurized
homogenized cow milk as the main milk source **from 9 to 12 months** for an
infant no longer breastfed. CDC and AAP say 12 months, not before.

**MILK is a US-9 allergen.** Iron essentially zero: `fdcId` **171284** = 0.05 mg
Fe, 121 mg Ca. Greek **2259794** = 0.0 Fe, 8.78 g protein. Dairy calcium
*inhibits* non-heme iron absorption — **do not co-serve yogurt as the "vitamin C
partner" for an iron meal.**
Hard rules: plain only (AAP: "avoid the added sugar commonly found in yogurt
marketed to babies"), pasteurized only, **whole-fat not low-fat** (AAP: babies
should get about half their calories from fat; restrict only after age 2).

## Tofu
**The strongest first-food credential in this batch — named by Health Canada,
CDC, AAP and NHS.** Health Canada lists it among iron-rich *first* foods.
**SOY is a US-9 allergen.** Choking **low** — soft and compressible, on no
hazard list.
**Iron varies ~5× by coagulant**, all verified:

| Form | fdcId | Fe mg/100g | Ca mg/100g |
|---|---|---|---|
| Regular, **calcium sulfate** | **172476** | **5.36** | 350 |
| Firm, calcium sulfate | **172475** | 2.66 | 683 |
| Hard, nigari | **174291** | 2.75 | 345 |
| Silken, firm (Mori-Nu) | **172461** | 1.03 | 32 |
| Dried-frozen (koyadofu) | **172450** | 9.73 | 364 |

Silken carries a fifth to a tenth the iron of calcium-set regular. If iron is
the goal, calcium-sulfate-set is the choice — noting the tension that the same
calcium inhibits non-heme absorption. Pair with a vitamin-C food.
Infant soy-phytoestrogen claims are **not** supported by any AAP/CDC/Health
Canada prohibition — do not repeat them as guidance.

## Korean pear (배, *Pyrus pyrifolia*)
⚠️ **No guideline body names Korean/Asian pear. It inherits the apple rules —
say that plainly.**
**Do not carry over the European-pear logic.** *Pyrus pyrifolia* is crisp and
hard even when fully ripe; it does not soften at ripeness, so it sits squarely
in AAP's "raw fruit chunks" category. **Cook until fork-mashable, or grate raw.
Peel either way.**
**Iron zero — verified:** `fdcId` **168177** = **0.0 mg Fe**, 3.8 mg C. A
hydration and flavour food, not a nutrient contributor.
Commonly used in Korean cooking as a marinade base with soy sauce and sugar —
both salt and added sugar are prohibited for infants. Serve plain, never as
marinade or bae juice.

## Spinach
Age ~6m cooked. **NHS names spinach as a recommended *first* vegetable** —
"start weaning with vegetables that aren't so sweet, such as broccoli,
cauliflower and spinach." CDC's 6–12m list leads with "cooked spinach."
Not a US-9 allergen. Choking low-to-modify — the issue is texture; cook and
chop finely so leaves don't ball up.
Iron **1.26 mg** baby spinach `fdcId` **1999632**, **1.05 mg** mature
**1999633**. A cooked-spinach fdcId is **unverified** (rate limit) — quote none.

### The oxalate claim is wrong — correct it rather than repeat it
Spinach iron *is* poorly absorbed, but **oxalate is not the reason.** Bonsmann
et al., *Eur J Clin Nutr* 2008;62(3):336–41 (PubMed 17440529): randomized
crossover, erythrocyte incorporation of labelled iron at 14 days. Kale meal
10.7% absorption; kale plus 1.26 g added potassium oxalate 11.5% — **P = 0.86,
no difference.** Spinach ran 24% below kale but not significantly. The authors
conclude potassium oxalate "did not influence iron absorption in humans" and
that oxalic acid in produce is "of minor relevance in iron nutrition,"
attributing spinach's disadvantage to **calcium and polyphenols**.

So: spinach is a modest non-heme iron food that is poorly absorbed because of
calcium, polyphenols and the plant-matrix form — and "oxalate blocks the iron"
is not supported by controlled human data. Oxalate's established relevance is
calcium binding and kidney stones, not infant iron status.

### Nitrates — a real US/EU disagreement, report both
**EU (more restrictive).** EFSA CONTAM Panel, Dec 2010: nitrate ADI **3.7 mg/kg
bw/day**; overall "not of health concern for most children", but a risk of
methaemoglobinaemia "cannot be excluded" for 1–3 year olds eating high amounts,
and for infants "a risk for some infants eating **more than one spinach meal in
a day** cannot be excluded." EFSA recommends children with **bacterial GI
infections not be given spinach**, since infection increases nitrate→nitrite
conversion. BfR adds: **cooked spinach should not be reheated.**
**US (much less restrictive).** AAP *Pediatrics* 2005;116(3):784 — well water is
the real high-risk vector; "little or no risk… from commercially prepared
infant foods", but "reports of nitrate poisoning from **home-prepared**
vegetable foods for infants continue to occur." CDC and DGA impose **no**
nitrate restriction and CDC actively recommends cooked spinach at 6–12 months;
NHS recommends it as a first vegetable.
**Net:** the US position is that spinach is a fine first food and the risk lies
with well water and improperly stored home-prepared purée. The EU adds three
actionable, costless precautions the US does not contradict: don't serve more
than one spinach meal a day, don't reheat cooked spinach, skip it during a GI
infection. Present both; the EU precautions are the safer default.

## Cucumber
⚠️ Not named in any AAP or CDC infant food list — NHS covers it in preparation
guidance only. Category-level coverage; food-specific is inference.
**Raw rounds are the exact geometry AAP warns about** — "do not feed children
younger than 4 round, firm food unless it is chopped completely" — and cucumber
is a hard raw vegetable under CDC's avoid line. **The skin is the specific
hazard**: it doesn't break down with gumming.
NHS's guideline-issued fixes: **narrow batons, never coins** ("cut vegetables
like carrots, peppers, cucumber and celery into narrow batons"); **peel it**;
or grate.
**Iron: `fdcId` UNVERIFIED — rate-limited. Publish no number.** Treat as a
hydration and texture food with no meaningful iron or vitamin C.
Chilled peeled spear for teething is common practice; the guideline-issued part
is peel + baton shape, not the chilling.

## Barley
Age ~6m. **FDA names barley explicitly** as a rice-cereal alternative in its
inorganic-arsenic guidance. Choking low when fully cooked past adult doneness.

### The wheat/gluten distinction, stated exactly
- **Barley is not wheat and is NOT one of the US 9 major allergens.** It
  requires no US allergen labelling.
- **Barley IS a gluten-containing grain.** FDA's gluten-free rule defines those
  as "wheat, rye, barley, and other grains produced by breeding" them.
- **Consequence: barley is relevant to celiac disease, not to wheat-allergy
  labelling.** A child with celiac must avoid it; a child with IgE wheat allergy
  is not by that fact barley-allergic. Do **not** present barley as a
  "wheat-free = safe for wheat allergy" grain without a clinician.
- **Gluten timing:** ESPGHAN — gluten may be introduced any time between 4 and
  12 completed months; timing doesn't affect cumulative celiac incidence
  (PubMed 26815017; 2024 update 38847232). No delay is warranted.

**Iron — fortification is the whole story**, all verified: fortified barley
infant cereal, dry `fdcId` **171358** = **48.2 mg**; prepared with whole milk
**172296** = 3.49; hulled **170283** = 3.6; pearled raw **170284** = 2.5;
**pearled cooked 170285 = 1.33**. Fortified cereal is ~36× cooked pearled
barley and is the single realistic vehicle for the 11 mg/day RDA short of meat.
Added iron absorbs inefficiently — pair with a vitamin-C food.
Prepare with breast milk, formula or water — **not cow's milk** before 12
months.

---

## Verification gaps — publish no numbers for these

1. **Cucumber fdcId and nutrients — unverified** (API rate limit).
2. **Cooked/boiled spinach fdcId — unverified.** Only raw baby (1999632) and raw mature (1999633) confirmed.
3. **CDC pages 403 to direct fetch** — content came via search retrieval of the correct URLs; re-check exact wording before shipping quotations.
4. **EFSA Journal 8(12):1935 full text paywalled** — EFSA content is from their own press release plus BfR's FAQ. The 3.7 mg/kg ADI is corroborated by both.
5. **AAP Pediatrics 2005;116(3):784 full text paywalled** — abstract only. The "spinach, beets, green beans, squash, carrots / under 3 months" detail came from secondary text; confirm against full text before stating it as an AAP recommendation.
6. **AAP Pediatrics 2010;125(3):601 choking statement not retrieved** — the ½-inch rule is cited from HealthyChildren.org, AAP's own consumer arm, which states it verbatim.
7. **Health Canada 6–24 month document 403** — quoted via search retrieval. Confirm the 9–12 month cow's-milk divergence on-page before publishing.
8. **No guideline body issues per-food stick dimensions.** Only AAP's ½ inch and NHS's qualitative "size of your own finger."
