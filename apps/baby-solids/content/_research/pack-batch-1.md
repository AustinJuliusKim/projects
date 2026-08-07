# Research pack — batch 1

Retrieved 2026-08-06. Primary sources only; no competitor site consulted.

**CDC retrieval note.** cdc.gov returns HTTP 403 to automated retrieval. CDC
text here came from Internet Archive captures of the predecessor URLs, cross-
checked against live search indexing of the current ones. Both URLs are given.
This is the manual re-check already queued as row H-6.

## Cross-cutting — read before authoring anything

### The only guideline-issued dimension in US pediatric guidance

> "Cut food for infants and young children into pieces no larger than one-half
> inch." — AAP, [Choking Prevention](https://www.healthychildren.org/English/health-issues/injuries-emergencies/Pages/Choking-Prevention.aspx)

**That is the only dimensional rule verifiable from a US guideline body.** No
body issues per-food, per-age dimensions. Every "finger-length", "two fingers
wide", or "thumbnail-sized" instruction in this canon is **`common_practice`,
not `guideline`**, and must be tiered accordingly. Our own age-band structure
(6-8 / 9-11 / 12-17) is likewise an editorial construct — CDC deliberately
refuses to bind textures to month bands.

### Shape rules that ARE guideline-issued

| Rule | Body |
|---|---|
| Cut cylindrical foods (hot dogs, sausage, string cheese) into short thin strips, not rounds | CDC |
| Cut small spherical foods (grapes, cherries, berries, tomatoes) into small pieces | CDC |
| Hard fruits and vegetables (apples, carrots) usually need cooking so they mash easily | CDC |
| Cook food until soft enough to easily mash with a fork | CDC |
| Remove all fat, skin and bones from poultry, meat and fish **before** cooking | CDC |
| Cook and finely grind or mash whole-grain kernels | CDC |
| Slice round foods lengthwise; grate raw vegetables; cook hard vegetables until soft | Canadian Paediatric Society |

CDC: <https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/when-what-and-how-to-introduce-solid-foods.html>
CPS: <https://caringforkids.cps.ca/handouts/healthy-living/feeding_your_baby_in_the_first_year>

### CDC/WIC explicit choking-hazard list — items touching this batch

Hard raw vegetables or fruit (raw carrots, apples) · tough or large chunks of
meat · bones in meat or fish · **whole beans** · whole cooked grain kernels ·
uncut grapes, berries, cherries, melon balls · whole or chopped nuts and seeds ·
chunks or spoonfuls of nut and seed butters.

<https://www.cdc.gov/infant-toddler-nutrition/foods-and-drinks/choking-hazards.html>

AAP adds: raw carrot sticks, meat sticks/sausages, cheese chunks, popcorn,
thick nut butter — avoid "until 4 years of age or older."

### Age

CDC/AAP/DGA: about 6 months; before 4 months is not recommended. WHO 2023:
animal-source foods — meat, fish, or eggs — **daily** from 6 months (strong
recommendation, low-certainty evidence). Health Canada/CPS: iron-rich foods at
~6 months, **at least twice a day**.

**No guideline body assigns different earliest-ages to different foods**, apart
from honey, cow's milk as a drink, juice (all <12m) and high-mercury fish. CDC:
"for most children, you do not need to give foods in a certain order." So the
differentiator across this batch is *form*, not *date*.

### Grasp milestones

Pincer "most often starts between 9 and 10 months"; a neat pincer "should be
present by 12 months" — AAP, Hand and Finger Skills. ⚠️ Obtained via indexed
page text, not a direct fetch (403). **Re-verify before shipping.**

No AAP/CDC text ties *palmar* grasp to a food shape. Any "palmar grasp → long
strips" claim is common practice, unverified.

### Prohibitions

Honey <12m (botulism) · cow's milk as a drink <12m (intestinal bleeding) ·
unpasteurized anything · added sugars and low-cal sweeteners <24m · high-sodium
foods <24m · high-mercury fish · raw or undercooked egg (children under 5 are
three times more likely to be hospitalized with Salmonella).

### Cooking temperatures (USDA FSIS)

Ground beef 160 °F · all poultry 165 °F · whole cuts 145 °F + 3 min rest · eggs
until white and yolk are firm, egg dishes 160 °F · fish 145 °F ⚠️ (chart 403'd;
from indexed text — verify before ship).

---

## Per food

Every `fdcId` below was verified live against fdc.nal.usda.gov on 2026-08-06.
Values per 100 g.

### Avocado
- Age ~6m (general, not food-specific). Choking **low** — naturally mashable, on no hazard list.
- Not a US-9 allergen. Latex-fruit cross-reactivity: **unverified** as infant guidance.
- Iron non-heme 0.55 mg · vitamin C 10.0 mg · `fdcId` **171705** (also **2710824** Hass, Foundation).
- No primary-source prohibition. "Roll in oats for grip" is common practice, unverified.

### Banana
- Age ~6m — **NHS names bananas explicitly** for around 6 months.
- Choking **low** when ripe. AAP names "small banana pieces" as a suitable soft finger food.
- Note: CDC's round-food rule names grapes, tomatoes, hot dogs, string cheese — **not banana**. "Never serve banana coins" is *not* guideline-issued.
- Iron non-heme 0.26 mg · vitamin C 8.7 mg · `fdcId` **173944** (overripe: **1105073**).

### Oatmeal
- Age ~6m. **CDC explicitly endorses oat**: "offer a variety of fortified infant cereals such as oat, barley, and multi-grain instead of only rice cereal." AAP: "Rice cereal does not have to be the first cereal."
- Choking low as smooth porridge; **whole kernels are on the hazard list** — CDC: "cook and finely grind or mash whole-grain kernels." Steel-cut falls under that.
- CDC prep: "Mix cereals and mashed cooked grains with breast milk, formula, or water to make it smooth."
- Oats are not a US-9 allergen; **wheat cross-contact** is the live risk but no infant-specific guideline addresses it — unverified.
- **The single biggest number in this pack — a ~70× iron gap:**
  - fortified infant oat cereal, dry: **64.1 mg** iron, 12.7 mg zinc · `fdcId` **171360**
  - plain rolled oats, dry, unfortified: **4.25 mg** · `fdcId` **173904** (also **2346396**, 4.34 mg)
  - cooked with water, unenriched: **0.90 mg** · `fdcId` **173905**
- **Arsenic — why oat over rice.** FDA action level for inorganic arsenic in infant rice cereal is **100 ppb**; FDA notes infant rice intake per body weight is ~3× an adult's. <https://www.fda.gov/food/hfp-constituent-updates/fda-issues-final-guidance-industry-action-level-inorganic-arsenic-infant-rice-cereals>
- FDA lead action levels (Jan 2025): 10 ppb processed baby foods, 20 ppb single-ingredient root vegetables.

### Beef
- Age ~6m. WHO: animal-source foods daily. Choking **modify** — "tough or large chunks of meat" on the hazard list.
- CDC: remove fat, skin, bones before cooking; cook until fork-mashable. CPS names "minced" — **ground beef is the guideline-friendliest form.**
- Not a US-9 allergen. Alpha-gal: unverified as infant guidance.
- **HEME.** CDC: heme iron "is more easily absorbed"; red meat named. 2.24 mg raw 90/10 `fdcId` **174030** · 2.71 mg cooked patty **174031** · 2.93 mg pan-browned crumbles **174034** · zinc 4.79 mg. **No vitamin-C pairing needed** — heme absorption isn't C-dependent.
- Cook ground to 160 °F. Processed beef (hot dogs, lunch meat, sausage) is doubly excluded: sodium *and* choking.

### Chicken thigh
- Age ~6m. CPS names cooked chicken among iron-rich first foods.
- Choking **modify** — same hazard-list entry. **AAP's own phrase "finely chopped chicken" is guideline-issued.**
- Remove skin, fat, bones before cooking; 165 °F. Thigh being more forgiving than breast is common practice, not guideline.
- **HEME**, lower than beef: 0.81 mg raw thigh `fdcId` **173627** · 1.13 mg roasted **172388** · 1.46 mg fried **172387**.

### Salmon
- Age ~6m as an allergen introduction — CDC names fish among foods to introduce when others are.
- ⚠️ **FDA/EPA fish advice is scoped to ages 1–11. No serving amount exists for under-12-months.** Any per-week ounce figure for a 6–11m old is unverified.
- Choking **modify** — bones. CDC: remove bones before cooking. NHS: "(no bones)". Flesh itself is low risk once deboned.
- **US-9 allergen (fish).** AAP 2019: no evidence delaying fish beyond 4–6m prevents allergy. **NIAID's addendum covers peanut only — do not badge fish guidance as NIAID.** High-risk infants: consult the pediatrician first.
- HEME 1.03 mg · `fdcId` **171998** (Atlantic, wild, cooked).
- **Mercury: "Best Choices" — and named in FDA's sub-list of Best Choices "even lower in mercury."** 2 servings/week from Best Choices, ~1 oz at ages 1–3.
- Cook through; no raw, smoked or cured. Check local advisories for wild-caught.

### Egg
- Age ~6m generally; **4–6m acceptable** as an allergen window per AAP.
- Choking **low** scrambled or mashed — AAP names scrambled eggs as a suitable finger food. Rubbery hard-boiled white is common practice, not a flagged hazard.
- **US-9 allergen (egg). Safe form is WELL-COOKED.** AAP: "Well-cooked eggs have been studied… and shown to reduce the risk of egg allergy when fed to infants regularly," quantity **"about 1/3 of a well-cooked egg."** Continue "at least weekly."
- Meta-analytic evidence: moderate certainty that introduction at 4–6m reduces egg allergy, "much better efficacy with using **cooked as opposed to raw** egg" (PMC6157280).
- HEME per CDC's own classification 1.19 mg · `fdcId` **173424**. (Egg iron is in fact poorly bioavailable and phosvitin-bound — cite CDC, don't editorialize.)
- **Hard prohibition on undercooked egg** (FDA). ⚠️ **Bodies disagree:** NHS permits raw/lightly cooked hen eggs carrying the British Lion stamp. For a US app, state FDA/CDC and disclose the divergence.

### Black beans
- Age ~6m — NHS names beans; CPS names "mashed beans, peas or lentils."
- 🚩 Choking **modify — "whole beans" is a direct CDC/WIC hazard-list entry.** Flag it as such.
- Mash or purée. **No guideline instructs removing bean skins** — common practice.
- Not a US-9 allergen. Black-bean/peanut cross-reactivity: no primary source, unverified.
- Non-heme 2.10 mg `fdcId` **173735** (black turtle: 2.85 mg **175187**) · **vitamin C 0.0 mg**, so a prime C-pairing candidate. CDC names broccoli among its vitamin-C foods — **black beans + broccoli is a CDC-supported pairing.**
- Sodium: cooked from dry is 1 mg/100 g; canned is far higher (figure unverified). Rinsing canned beans is common practice.

### Lentils
- Age ~6m — NHS and CPS both name lentils.
- Choking **low-to-modify**: not individually named, but "whole beans" is a pulse-category entry. Red/split break down much softer. **State the ambiguity rather than resolving it.**
- Not a US-9 allergen (a notable pediatric allergen in some Mediterranean/South Asian cohorts, but not US guidance — unverified).
- **Highest non-heme value in this batch: 3.33 mg** · `fdcId` **172421** · protein 9.02 g · vitamin C 1.5 mg → pair with a C food.

### Broccoli
- Age ~6m. **NHS names broccoli explicitly** and recommends starting with less-sweet vegetables: "broccoli, cauliflower and spinach." The strongest food-specific citation in this pack.
- Choking **modify** — hard raw vegetable. Cook until soft.
- Non-heme 0.67 mg `fdcId` **169967**, but its real role is **vitamin C 64.9 mg — CDC explicitly names broccoli** as a C-rich food for boosting non-heme absorption. Guideline-issued pairing.
- Frozen: 0.61 mg Fe, 40.1 mg C `fdcId` **169969** — a ~38% C drop fresh→frozen, USDA-verified.

### Carrot
- 🚨 **Highest-flag item in this batch — named on BOTH hazard lists by name.** CDC/WIC: "raw carrots." AAP: "raw vegetables like carrot sticks," avoid until 4+. **Raw carrot = avoid. Cooked soft = modify.**
- CDC: "Cook hard vegetables and fruits, such as carrots and apples, so you can easily mash or puree them."
- ⚠️ Cooked carrot **coins** are round, but CDC's round-food rule is written about grapes and hot dogs, not carrots. "Never serve carrot coins" is a **defensible extrapolation, not guideline-issued** — badge it as inference.
- Non-heme 0.34 mg `fdcId` **170394** · vitamin C 3.6 mg (weak; CDC does *not* list carrots among C foods).
- **Nitrate / methemoglobinemia:** AAP policy statement, *Pediatrics* 2005;116(3):784. High-nitrate vegetables (spinach, beets, green beans, carrots, squash) advised against under ~3 months; documented risk vector is home-prepared purée stored 12–27 h refrigerated. Commercial US infant food poses "little or no risk." ⚠️ Retrieved from indexed abstracts, not full text — **verify before ship, and publish no ppm number** (none verified).

---

## Unverified register — do not invent these

1. Any per-age dimension other than AAP's ≤½ inch.
2. Palmar-grasp → food-shape mapping.
3. Pincer at 9–10 months (AAP-attributed via indexed text only; page 403'd).
4. Fish cooking temp 145 °F (chart 403'd).
5. Salmon serving amounts under 12 months — **no infant figure exists.**
6. Nitrate ppm thresholds for carrot.
7. Oat/wheat cross-contact as infant guidance.
8. Canned-bean sodium.
9. Avocado latex cross-reactivity · beef alpha-gal · lentil allergy · bean-skin removal · carrot-coin prohibition.

## Disagreements to surface, not resolve

- **Raw/lightly cooked egg:** NHS permits it with British Lion–stamped eggs; FDA/CDC prohibit undercooked egg for everyone and flag under-5s specifically.
- **Age framing:** "about 6 months" (AAP/CDC/WHO) vs a 4–6 month allergen window (AAP) vs 4–6 months for peanut in high-risk infants only (NIAID). Compatible, but they read differently to a parent.
- **Texture by age:** CDC deliberately refuses to bind textures to month bands. Our three-band structure is editorial.
