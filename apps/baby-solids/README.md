# baby-solids

A food canon and feeding tracker for starting solids: what to serve, how to
cut it, what it's a source of, and — the part no other app does well — keeping
allergens in the rotation after they're introduced.

Not a Solid Starts clone. Their food database is free on the web and backed by
a clinical team and a photo library no solo build can match. What they charge
for is the tracker, and that's the part with the bad reviews. This builds that,
cites primary sources instead of claiming authority, and skips the corpus race.

## Running it

```bash
npm ci
npm ci --prefix ../../packages/baby-core   # file:-linked; see "Gotcha" below
npm run dev
```

Then open the printed URL. v1 works fully offline and stores everything in
`localStorage` — no account, no server.

## Scripts

| script | what it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | compiles content, then builds |
| `npm run build:content` | `content/foods/*.md` → `src/generated/foods.json` |
| `npm run check` | fails if the generated JSON has drifted from the Markdown |
| `npm run check:sql` | fails if any food stopped being relationally expressible |
| `npm test` | `node --test` over the pure modules |

## How content works

One Markdown file per food in `content/foods/`. YAML frontmatter carries the
structured fields; the body carries the prose, split into addressable sections
(`## Prep 6-8`, `## Safety`, `## Background`). `[[wikilinks]]` between foods
compile to `relatedIds`.

Files are editable in Obsidian, which is the point — authoring a hundred foods
over two hundred days has to be pleasant or it won't happen.

**The compiler is the reviewer.** These are records a parent acts on, so the
build fails rather than shipping something malformed. Nine gates have tests
asserting they fail: missing source, unknown allergen, unresolvable geometry,
duplicate id, unknown enum value, unresolvable wikilink, an age band with no
prep section, `choking: avoid` with no note, and — the one that matters most —
an `allergenProtocol` with no `medicalGate`.

There is no database and v1 doesn't need one. `content/SCHEMA.md` documents the
relational mapping anyway, and `npm run check:sql` re-proves on every run that
the canon could still be imported into it. That keeps "importable later" true
as the canon grows instead of a claim discovered false in January.

### Size, measured

The whole canon is bundled so search is instant and works offline. Measured at
3 foods and projected linearly: **~3.5 KB per food raw**, so a 110-food canon
lands around **375 KB raw / ~152 KB gzipped** — roughly doubling the app's
current transfer. Fine for something you install to the home screen once and
then use offline, and still far better than a network round trip per lookup.

If the canon ever grows past ~150 foods, the fix is to split rather than to
add a server: ship a light index (id, name, aliases, category, age, badges)
that browse and search need, and lazy-load the full record — prose, prep, and
sources — per food page. The compiler already emits the index separately, so
that's a build change, not a rewrite.

## Architecture

Static SPA on S3 + CloudFront. **No Lambda, no database, no API.**

Sync (when enabled) is browser-to-S3 directly: a Cognito Identity Pool
federating Google exchanges an `id_token` for temporary credentials scoped by
IAM to one household prefix. Each device writes exactly one object —
`households/<id>/devices/<identityId>.json` — so there is never a second
writer on a key, and reconciliation is a pure merge on read. No locks, no
conditional writes, no conflicts to resolve.

Two invariants live in `packages/baby-core` and are enforced by schema:

- **Timestamps carry an explicit offset.** A naive local datetime is rejected,
  not coerced.
- **Deletes are tombstones.** With multi-writer merge an absence is
  indistinguishable from "not synced yet", so a removed event would come back.

## Gotcha: the `file:`-linked package

`npm ci` symlinks `@baby/core` but does **not** install its dependencies. Node
resolves the package's own `zod` import through the symlink's real path, so
every context that touches it needs a second install:

```bash
npm ci --prefix ../../packages/baby-core
```

CI does this in its own step, and `deploy-frontend.sh` does it before building.

## Deploying

Not wired up yet — the workflow is gated on `vars.BABY_SOLIDS_DEPLOY_ENABLED`
and the first stack CREATE must be done by hand.

1. Create a Google OAuth client; note its client id.
2. Put it in `deploy-params.json` (replacing `FILL_AFTER_OAUTH_CLIENT`) and set
   `HouseholdId`.
3. First deploy, manually:
   ```bash
   aws cloudformation deploy --template-file template.yaml \
     --stack-name BabySolids --region us-west-2 --capabilities CAPABILITY_IAM \
     --parameter-overrides GoogleClientId=... HouseholdId=... \
       CustomDomain= CertificateArn= WebAclArn= SyncAllowedOrigin='*'
   ```
4. Create the `baby-solids-github-deploy` IAM role with the repo's OIDC trust
   policy. Newer repos emit the immutable `repo:OWNER@id/REPO@id:` subject
   form, so a policy copied from an older repo fails with a misleading
   authorization error.
5. Set the repo variable `BABY_SOLIDS_DEPLOY_ENABLED=true`.
6. Tighten `SyncAllowedOrigin` from `*` to the real site origin on the second
   deploy — the distribution domain doesn't exist before the first one.

Then verify the security boundary by hand: signed in as one caregiver, confirm
you **cannot** `PutObject` to the other device's key. It's the only such
boundary in the app; don't assume the policy variable resolved correctly.
