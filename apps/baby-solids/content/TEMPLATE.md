# Authoring a food record

Copy the skeleton below into `content/foods/<id>.md`. The filename **is** the
`id` and the primary key, so pick it carefully — it's immutable once published.

Run `npm run build:content` after editing. The compiler will tell you what's
wrong; it's meant to be argued with, not guessed at.

This file lives outside `content/foods/`, so it is never compiled.

## Rules that matter

- **Never invent a number.** If you can't verify an age, a gram amount, a
  dimension, or a dose from a primary source, leave the field out. An omitted
  field is honest; a plausible-looking wrong one is how someone gets hurt.
- **Sources are primary only** — AAP/HealthyChildren, CDC, WHO, NHS, Health
  Canada, NIAID, AAAAI, CSACI, FDA/EPA, USDA FoodData Central, or peer-reviewed
  literature. **Never** a competing baby-feeding app or blog: their terms bar
  derivative works, and the selection and arrangement of their food set is
  protected.
- **Tier your sources honestly.** Cut-size-by-grasp rules are `common_practice`,
  not `guideline` — the grasp milestones are AAP-confirmed but the specific
  dimensions aren't issued by anyone. Mislabelling a tier is how folklore gets
  laundered into advice.
- **Don't repeat these**, all of which are common and wrong: "wait 3–5 days
  between new foods" (not evidence-based; reactions occur within two hours),
  "food before one is just for fun" (iron and zinc needs say otherwise),
  "gagging means they aren't ready" (it's a working reflex), any suggestion of
  allergy-panel screening (very low positive predictive value in infants), and
  any BLW framing that isn't the modified/BLISS version.
- **`reviewedOn` is not yours to set while drafting.** Add it only after a
  human has read the record back against its sources. `npm run review:status`
  lists what's outstanding.

## Skeleton

```markdown
---
id: <matches-the-filename>
name: <Display name>
aliases: [romanization, 원어, other common names]   # drives search
category: fruit | vegetable | grain | starch | animal_protein | plant_protein | dairy | fat | herb_spice | other
firstOkMonths: 6
ageBands:                     # each needs a matching "## Prep <band>" below
  - band: "6-8"
    geometry: spear-two-finger      # must exist in enums.yaml
    servingNote: optional one-liner
  - band: "9-11"
    geometry: pincer-cube
  - band: "12-17"
    geometry: bite-size-mixed
allergens: []                 # subset of the US 9; omit non-US ones unless relevant
allergenRegion: US
choking:
  level: low | modify-required | avoid
  requiredModification: what must be done to make it safe
  note: required when level is "avoid"
nutrients:
  ironType: heme | non_heme | fortified | none
  tags: [vitamin-c, fiber]
  # ironMgPer100g / proteinGPer100g / fdcId — only if verified on fdc.nal.usda.gov
cultural: [general]           # add korean, japanese, indian, latin, …
prepMinutes: 20
sources:
  - url: https://…
    body: American Academy of Pediatrics
    tier: guideline | trial | expert_opinion | common_practice
    retrieved: YYYY-MM-DD
---

## Background

Why this food is worth serving, in a couple of sentences. Cross-link a
related food with [[its-id]] — the compiler fails on links that don't resolve.

## Prep 6-8

How to prepare and cut it, tied to what the baby can physically do: whole-hand
grasp at this age means finger-length pieces the baby holds while biting the
protruding end. Pieces cut small are harder now, not safer.

## Prep 9-11

What changes when the pincer grasp arrives, usually around nine months.

## Prep 12-17

Usually "however the rest of the table is eating it", with any caveat.

## Safety

The specific hazard and the specific modification. Skip this section entirely
if there's nothing real to say — an empty safety note trains people to ignore
the ones that matter.
```

## Allergen foods need one more block

Only for foods used to introduce one of the nine major allergens:

```yaml
allergenProtocol:
  allergen: peanut
  firstDose: A concrete, measurable first serving.
  maintenanceProteinGPerWeek: 6
  maintenanceMinSessionsPerWeek: 3
  medicalGate: >-
    Who needs to talk to a clinician before the first exposure, and why.
```

`medicalGate` is **required** and the build fails without it. It is the only
medical warning in the entire dataset, and the app renders it as the first
thing on the page — an allergen record that quietly lost its gate is worse
than no record at all.
