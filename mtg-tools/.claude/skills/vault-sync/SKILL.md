---
name: vault-sync
description: Sync ObsidianVault notes after changes in binders/, webapp/ or frontend/, or after any decision the code alone won't explain. Run before shipping or opening a PR so the vault stays accurate and locked decisions don't silently drift.
---

# vault-sync — update the ObsidianVault after work in mtg-tools

The vault at `/Users/aukim/personal/ObsidianVault/` holds this repo's *reasoning*
— why prices are entered by hand, why the tier rates are what they are, which
standards this repo follows and where it deliberately doesn't. The code holds the
what; the vault holds the why, and the why goes stale silently.

This skill adds only the mtg-tools→note mapping. **All vault-editing rules come
from the vault itself.**

## 1. Read the vault's protocol first

Read `/Users/aukim/personal/ObsidianVault/.claude/skills/wiki/SKILL.md` and
`/Users/aukim/personal/ObsidianVault/.claude/CLAUDE.md`. Their write protocol,
frontmatter schema and guardrails govern every edit made here. Do not restate or
override them.

## 2. Decide whether there is anything to sync

Two triggers, and the second matters more:

**Code changed.** Collect the union of:

```sh
git diff --name-only $(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main)
git diff --name-only HEAD
git ls-files --others --exclude-standard
```

Reduce to prefixes matching `^(binders|webapp|frontend)/`.

**A decision was made.** Code diffs miss these entirely, and they are the ones
worth recording. A decision qualifies if a future reader would otherwise
re-litigate it or contradict it by accident:

- a rejected alternative and *why* (an API that is closed, a library that was
  wrong for the job, a rate that corresponds to no real offer)
- a constraint discovered from real data or a real vendor
- a deviation from a standard in `20-notes/` — **always** record these
- a number that will be quoted elsewhere (valuations, tier splits, card counts)
- a bug whose cause is non-obvious from the fix

If neither trigger fires, report "nothing to sync" and stop. A commit that
renames a variable does not need a vault note.

## 3. Map to notes

- `10-maps/Projects MOC.md` → the project index; `10-maps/Engineering MOC.md` →
  standards.
- This repo's note is `30-projects/MTG Collection Tooling.md`.
- Standards this repo is bound by: `20-notes/Frontend Stack Standards.md`,
  `20-notes/Node Runtime Standard.md`.
- Downstream consumers of its numbers: `30-projects/Paternity Leave Project Plan.md`
  (tier tables, multi-copy flags), `30-projects/Financial Freedom Profile.md`
  (ledger schema, insurance).
- Then `grep -l` across `30-projects/` and `20-notes/` for `mtg-tools`, `binders`
  and the specific feature name — a bounded scan, the sanctioned exception to the
  vault's no-full-scan rule.

## 4. Update

- Correct only claims made stale **by this session**. Append to status sections
  rather than rewriting history; bump `updated:`.
- **Regenerate figures rather than hand-editing them.** Any number the tool can
  produce should come from the tool:
  `python3 -m binders tiers ~/Desktop/Binders*.csv --markdown`
- **Never silently overwrite a figure that describes a different set.** When the
  underlying data changed, say which is which — the tier table already carries
  both an as-scanned and a current figure for exactly this reason.
- A new standing decision is an atomic note in `20-notes/` via the wiki skill's
  write path, linked from its owning MOC — never an ad-hoc file.
- A deviation from an existing standard is recorded **in that standard's note**,
  with the open question stated, so it reads as a documented exception rather
  than a precedent.
- Never rename or delete notes. Never leave dangling wikilinks.

## 5. Verify before committing

```sh
cd /Users/aukim/personal/ObsidianVault
python3 - <<'PY'
import re, glob, os
notes = {os.path.splitext(os.path.basename(p))[0] for p in glob.glob('**/*.md', recursive=True)}
for f in <files you touched>:
    bad = [l.strip() for l in re.findall(r'\[\[([^\]|#]+)', open(f, encoding='utf-8').read())
           if l.strip() not in notes]
    print(f, bad or 'links ok')
PY
```

## 6. Commit

```sh
git -C /Users/aukim/personal/ObsidianVault add <only the files this skill touched>
git -C /Users/aukim/personal/ObsidianVault commit -m "vault-sync: <summary> (mtg-tools@$(git rev-parse --short HEAD))"
```

The vault works on branches with PRs, so branch off current `main` first — a
previous session's stale branch may still be checked out, and committing onto a
merged branch strands the notes. Do not push or open a PR unless asked. Leave
unrelated dirty files alone.

## 7. Report

Say which notes changed and why, or that there was nothing to sync. If a figure
was regenerated, give the old and new values — a silently updated number is the
one a reader will trust without checking.
