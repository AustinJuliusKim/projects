/**
 * Zod schema for a compiled food record.
 *
 * Enum members are injected from content/enums.yaml rather than hardcoded, so
 * the vocabulary has exactly one home. A value absent from that file fails the
 * build — which is the point: a typo in an allergen id or a choking level is a
 * silent safety gap, not a formatting nit.
 */

import { z } from "zod";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {Record<string, string[]>} enums parsed content/enums.yaml
 */
export function buildFoodSchema(enums) {
  const oneOf = (key) => z.enum(/** @type {[string, ...string[]]} */ (enums[key]));

  const source = z.object({
    url: z.string().url(),
    body: z.string().min(1),
    tier: oneOf("evidenceTiers"),
    retrieved: z.string().regex(DATE_ONLY, "retrieved must be YYYY-MM-DD"),
  });

  const ageBand = z.object({
    band: oneOf("ageBands"),
    geometry: oneOf("geometries"),
    servingNote: z.string().optional(),
    // prepMd is filled from the body's "## Prep <band>" section by the
    // compiler, then required — see compile-content.js.
    prepMd: z.string().min(1).optional(),
  });

  const allergenProtocol = z.object({
    allergen: oneOf("allergens"),
    firstDose: z.string().min(1),
    proteinGPerTsp: z.number().positive().optional(),
    maintenanceProteinGPerWeek: z.number().positive().optional(),
    maintenanceMinSessionsPerWeek: z.number().int().positive().optional(),
    /**
     * HARD SAFETY INVARIANT. This carries the NIAID severe-eczema /
     * egg-allergy carve-out: most infants can be introduced at home, but that
     * group needs clinician contact first. `.min(1)` on a required field means
     * omitting it fails the build rather than shipping a food that quietly
     * drops the only medical warning in the dataset.
     */
    medicalGate: z.string().min(1),
  });

  return z.object({
    id: z.string().regex(SLUG, "id must be a lowercase slug"),
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)).default([]),
    category: oneOf("categories"),
    firstOkMonths: z.number().int().min(4).max(60),
    ageBands: z.array(ageBand).min(1),
    allergens: z.array(oneOf("allergens")).default([]),
    allergenRegion: oneOf("allergenRegions").default("US"),
    allergenProtocol: allergenProtocol.optional(),
    choking: z.object({
      level: oneOf("chokingLevels"),
      note: z.string().optional(),
      requiredModification: z.string().optional(),
    }),
    hardAgeRestrictionMonths: z.number().int().positive().optional(),
    prohibitedBeforeMonths: z.number().int().positive().optional(),
    prohibitionReason: z.string().optional(),
    /**
     * An upper bound on how often a food should be served, with the reason.
     *
     * Distinct from an age restriction: liver is excellent at six months and
     * still shouldn't be served daily, because preformed vitamin A accumulates.
     * Every other cap in the dataset is "not before N months"; this is the only
     * shape that says "yes, but not this often", and without it the canon would
     * have to bury that in prose where nothing can act on it.
     */
    frequencyLimit: z
      .object({
        maxPerWeek: z.number().positive(),
        reason: z.string().min(1),
      })
      .optional(),
    nutrients: z
      .object({
        ironType: oneOf("ironTypes"),
        ironMgPer100g: z.number().nonnegative().optional(),
        proteinGPer100g: z.number().nonnegative().optional(),
        fdcId: z.number().int().positive().optional(),
        tags: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    cultural: z.array(oneOf("culturalTags")).default(["general"]),
    prepMinutes: z.number().int().positive().optional(),
    sources: z.array(source).min(1, "every food needs at least one source"),
    /**
     * Date a human read this record against its cited sources.
     *
     * Absent means nobody has. Records are drafted from primary sources, but
     * drafted is not the same as checked, and this is advice a parent acts on
     * with their own child — so the distinction is carried in the data and
     * shown in the UI rather than tracked on a checklist somewhere.
     */
    reviewedOn: z.string().regex(DATE_ONLY, "reviewedOn must be YYYY-MM-DD").optional(),
    // Derived by the compiler from the body.
    relatedIds: z.array(z.string().regex(SLUG)).default([]),
    backgroundMd: z.string().optional(),
    safetyNoteMd: z.string().optional(),
  });
}
