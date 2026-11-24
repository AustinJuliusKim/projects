# Research pack — batch 6 (PARTIAL): plant proteins

⚠️ **This is a summary, not a full pack.** The research agent ran without write
access and the session's web-search budget was exhausted (200/200) before the
detail could be recovered. What follows is the verified core it reported. **It
is not sufficient to author records from** — per-food prep-by-band, choking
modifications and citations are missing. Re-run this batch with a writable agent
and a fresh search budget before authoring.

Foods in scope (12): chickpeas/hummus, edamame (풋콩), mung bean (녹두), pinto
beans, adzuki (팥), natto (낫토), tempeh, soybean sprouts (콩나물), black-eyed
peas, pumpkin seed butter, doenjang (된장).

## 🚩 Affects records already written — the Dietary Guidelines edition changed

ODPHP now lists the current edition as **Dietary Guidelines for Americans
2025–2030 (10th edition, January 2026)**. Existing records cite the **2020–2025**
edition for "no added sugars under 24 months."

**The replacement text could not be verified** — dietaryguidelines.gov and
realfood.gov both timed out or refused. So the added-sugar prohibition is
currently **anchored to a superseded edition**, and nobody has confirmed whether
the 10th edition restates it, changes the age, or drops it.

This is the same class of error as the retired AAP nitrate report, caught
earlier: a citation that was correct when written and quietly went stale. It was
also flagged in this project's very first clinical brief as "verify before
ship." **It is now the top item in the human-verification queue** — every record
citing DGA for added sugars is affected.

## Verified live (USDA FDC `portal-data` endpoint)

| Food | Finding | fdcId |
|---|---|---|
| Pumpkin seed kernels | **8.82 mg Fe**/100 g | 170556 |
| Pepitas | 8.36 mg Fe | 2515380 |
| Pumpkin seed butter (branded) | 12.9 mg Fe — **but salted, 286 mg Na** | 2033964 |
| Natto | **8.60 mg Fe** | 172443 |
| Commercial hummus | **426 mg Na/100 g** | 174289 |
| Adzuki, plain cooked | 24.8 g carb, 7.52 g protein | 173728 |
| Adzuki, canned sweetened | **55.0 g carb, 3.80 g protein** | 173729 |

**The hummus number is the standout.** NASEM's sodium AI for 7–12 months is
**370 mg/day**. Commercial hummus at 426 mg/100 g means a single modest serving
can exceed the entire daily adequate intake. Home-made without salt is a
different food from the tub.

**The adzuki contrast is the argument in one line:** sweetening more than doubles
the carbohydrate and halves the protein. 단팥 and most 팥죽 are the sweetened
form.

## Refused — do not invent

- **Doenjang has no USDA FDC entry at all.** Miso (`172442`, Na **3,730
  mg/100 g**) was recorded only as an explicitly different food, not a proxy
  figure. Publish no doenjang number.
- **Natto's K2/menaquinone is refused.** USDA carries only phylloquinone
  (23.1 µg) with no menaquinone field, so the widely repeated "extremely high
  K2" claim is unsupported by any primary source reachable this session.
- **fda.gov returned 404/403 on every allergen path tried**, so the US-9 list
  was not re-verified this session. Soy is anchored instead to AAP's live
  wording ("eggs, dairy, soy, peanut products or fish"); sesame to NHS.
- **Raw-sprout pathogen advice unverified** — FDA and CDC both unreachable.
  Soybean and mung sprouts carry a cook-thoroughly instruction as inference
  only.
- **CDC's "whole beans" hazard entry could not be re-fetched** (403 to both
  WebFetch and curl). Carried forward from pack-batch-1's same-day retrieval and
  badged as such. It is **not** age-limited to under 12 months.
- **Edamame skin:** no body addresses it. The nearest guideline hook is NHS's
  "removing the skin… makes it easier to swallow." Smashing is
  `common_practice`.
- **Natto's sticky strands:** no primary source exists. Reported as unverified,
  not as a hazard.
