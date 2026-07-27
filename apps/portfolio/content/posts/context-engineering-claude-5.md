---
title: "The 80% I couldn't cut"
date: "2026-07-26"
description: "Anthropic deleted 80% of Claude Code's system prompt with no measured performance loss. I counted mine: 1,984 lines across four locations, several of them unsatisfiable."
tags: [context-engineering, claude-code, agents]
draft: false
---

Anthropic published a post saying they'd deleted more than 80% of Claude Code's system prompt and measured no drop in performance, which is a genuinely upsetting thing to read on a Sunday when you have spent eight months adding rules to your own config on the theory that more rules meant fewer mistakes. Their phrasing was that they had been "overconstraining Claude Code, both through our system prompt and in our CLAUDE.md files and skills," and I want to be clear that my first reaction was not curiosity, it was the specific defensiveness of someone who suspects they are about to be personally called out by a blog post that has never met them.

So I counted. 1,984 lines of standing instruction across four places: my monorepo, my wife's portfolio repo, my Obsidian vault, and the global config that loads into every single session on this machine. I had never read all of it in one sitting. I had only ever added to it, the way you add to a junk drawer.

## It wasn't bloat, it was wrong

I expected to find waste. Waste is fine, waste is just a diet. What I found instead was that several of the instructions were unsatisfiable, and had been for months, and nothing had visibly broken, which is somehow worse.

My `developer` agent contained the line "YOU MUST request review from ALL OF @code-reviewer, @code-reviewerer, in parallel," followed two lines later by a requirement that it get approval from both before proceeding. There is no `@code-reviewerer`. There is no file, there never was, it is a typo that calcified into a requirement. For months I had been shipping an agent whose completion gate depended on the approval of an entity that does not exist, like leaving a chair at the table for a relative nobody has met.

Two files disagreed about whether to create an `ARCHITECTURE.md`: one mandated it, one forbade it, and my `CLAUDE.md` cheerfully instructed me to keep those two files in sync, which is an instruction to hold a contradiction with both hands. My model routing was stated in five separate places and two of them disagreed, so the global file was routing architecture work to Sonnet while the repo file routed it to `fable`, and both loaded at the same time. The global file also banned running `git push` under any circumstances, which is an interesting position for it to take given I have a `ship` skill whose entire job is pushing and opening PRs, and a `wake-on-reset` skill with an explicit full-auto mode that does the same thing unattended.

Then there was the accessibility check. In my wife's portfolio repo, four separate files told agents to run an axe accessibility check after structural changes, and the reviewer file made passing it a condition of approval. `git log --all` says no such script has ever existed in that repository. Not deleted. Never written. Four files enforcing a ritual around an object that was never there.

## The file that wasn't mine

The best one was the global config, the file that loads into every session I run.

It was a symlink into a work repository. Not my work — a team config repo on my employer's GitHub, pointed at from my personal machine, and it had been that way since June. When I audited it for anything personal, anything about my paths or my accounts or my projects or my preferences, I found nothing. Zero lines. It was 89 lines of generic advice about being a careful engineer, plus a numbered listicle titled "Additional Cost Savings measures" that was pasted in from somewhere, still wearing someone else's voice, referring to "our workflow" and something called "the $47 one-click deploy incident" that I have no memory of and did not attend.

That listicle is where the hardcoded caps lived. "After 10 tool calls without visible progress, stop." "This should complete in under 20 tool calls." "If you write 200 lines and it could be 50, rewrite it." Numbers with no relationship to any task I actually run, firing on every session, on a machine where a routine vault sync takes more than 20 tool calls before it has finished deciding what changed.

I checked whether that block was at least committed to the team repo, so I could tell myself it was a real shared decision someone had reviewed. `git diff` says 23 insertions, uncommitted, sitting in my working tree since June. I had pasted it in, never committed it, never read it again, and let it shape every session on the machine for two months.

## What I actually cut

1,984 lines down to 897 always-loaded. 54%.

Not 80%, and the gap is the interesting part. Anthropic's 80% came out of a system prompt that was mostly generic scaffolding, and generic scaffolding is exactly what a Claude 5 model already knows. Mine wasn't all generic. Buried in the sprawl was a real accumulation of things that are not derivable from the code: the NDA clearance rules for my wife's portfolio, where publishing a case study she isn't cleared to show has consequences that land on her and not on the site. The note that a rename in my vault silently breaks wikilink backlinks until the Obsidian MCP is live. The gotcha that session-only cron jobs die with the CLI, learned the hard way at 2am.

My monorepo config took a 72% cut because it was mostly the same four facts restated in five files. My wife's repo took 40%, because underneath the pasted listicle there was a real specification of a real constraint. Cutting to hit 80% would have meant deleting the parts that were actually load-bearing, and the only thing worse than a config full of noise is a config that deleted its own guardrails to look tidy.

## Then I let it review its own rewrite

The `code-reviewer` agent went from 66 lines to 29. Most of what I removed was a mandated output template telling it which headings to emit and a generic security checklist about SQL injection and path traversal, on repos that have no database and no user input.

Then I pointed the 29-line version at the rewrite and asked whether I had deleted anything load-bearing.

It found six defects. Five were mine.

The one that actually stung: while consolidating duplicated facts into `CLAUDE.md`, I had promoted the line "CI runs `npm ci && npm test && npm run build` per area" into the repo-level statement of truth. It is false. I checked the workflows after the reviewer flagged it, and the portfolio workflow runs `npm ci` and `npm run build` with no test step, the choices-webapp backend job runs `npm ci` and `npm test` with no build step, and several areas have no build script at all. It had been sitting inside one agent file as a rough note, where being approximately right was survivable. By promoting it to the single source of truth I had made a vague note into an authoritative lie, and I did it in the same commit where I congratulated myself for stating each fact exactly once.

It also caught that I had turned the vault-scan rule into a circular one. The old version said to scan the vault before starting any task. My tidier version said to scan it when a task touches a documented project decision, which sounds more precise and is actually unusable, because you cannot know whether a task touches a documented decision until you have gone and looked.

A 29-line reviewer caught a factual error that a 66-line reviewer had been carrying for months. That is the whole argument, and I did not have to make it, it made itself.

## The delete test

The pattern in everything I cut is that the least defensible lines were the ones I had pasted in and never re-read. Not the ones I wrote after getting burned. Those were fine. Those were the best lines in the whole config.

So run this on your own setup this afternoon. Go through your config line by line and ask, for each rule: what specifically breaks if I delete this? Name the failure. Not "the model might be sloppy" — an actual failure you can describe, ideally one you have personally watched happen.

If you can name it, keep it, and it will usually turn out to be a fact about your environment rather than advice about being a good engineer. If you can't name it, you are looking at decoration, and it has been quietly competing for attention with the lines that would have saved you.

I found four files enforcing a check that never existed. I would start there.

*The whole rewrite is public if you want to read the diff, contradictions and all: [AustinJuliusKim/projects#62](https://github.com/AustinJuliusKim/projects/pull/62). If you run the delete test on your own config, tell me what you found — I want to know whether the phantom accessibility check was a me problem.*
