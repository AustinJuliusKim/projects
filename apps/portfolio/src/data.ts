// Single source of truth for site content.
// Edit this file to update copy. Anything marked [confirm] needs a real figure
// from Austin before the site goes live.

export const profile = {
  name: "Austin Kim",
  // The one-liner thesis, shown in the hero.
  tagline: "Senior software engineer building AI-native developer & learning tools.",
  // A slightly longer positioning line under the tagline.
  subtitle:
    "A decade shipping React + AWS at scale — Loot Crate, Ring/Amazon, Riot Games. Now building products on top of Claude.",
  location: "Los Angeles, CA · Open to remote",
  email: "austinjuliuskim@gmail.com",
  links: {
    github: "https://github.com/AustinJuliusKim",
    linkedin: "https://www.linkedin.com/in/austinjuliuskim/",
    resume: "/resume",
  },
};

export const about = [
  "I'm a product-minded engineer with roughly a decade shipping user-facing web software. I started in front-end at Loot Crate, porting a legacy Rails/CoffeeScript app to React/Redux, then spent three years at Ring (Amazon) building micro-frontends embedded in the Ring iOS and Android apps on AWS CDK.",
  "At Riot Games, I build internal developer platforms and tooling for game playtesting — the systems teams use to gate access to builds and run internal and public alpha/beta tests, from company-wide to player pools in the millions. I also built a shared Portal component library and a cross-team contribution model so teams across Riot ship consistent UX.",
  "Since late 2025, I've gone deep on building with LLMs: agentic development with Claude Code, and shipping my own AI-native products — a platform that teaches Claude Code by replaying real recorded sessions, a live consumer app with Claude-powered features, and a card-similarity API built on vector search. This site and everything below it are things I designed, built, and deployed end-to-end.",
];

export type Project = {
  name: string;
  tagline: string;
  description: string;
  highlights: string[];
  /** Short chips, used by the condensed /resume listing. */
  stack: string[];
  /** Labeled rows, used by the richer site cards. */
  spec: { label: string; value: string }[];
  status: "live" | "in-progress";
  /** Nuance under the badge, when "live" alone would overstate it. */
  statusNote?: string;
  /** Only set when the URL is public and worth sending someone to. */
  live?: string;
  source?: string;
  /** Opt in to the one-page résumé, which can't hold every project. */
  onResume?: boolean;
};

export const projects: Project[] = [
  {
    name: "Guided REPL",
    tagline: "An AI-native learning platform that teaches Claude Code by replaying real sessions.",
    description:
      "A browser playground that walks you through real, recorded Claude Code (`claude -p`) runs frame-by-frame — a split-pane CLI plus a live workspace — turning an opaque agent into something you can actually learn. Eight guided lessons cover the prompt ladder, plan mode, permission modes, reading diffs, CLAUDE.md, and cost/model tradeoffs.",
    highlights: [
      "Designed a frame/fixture protocol and a seeder CLI that records real Claude Code runs into replayable fixtures",
      "Replay is the architecture: no live agent and no API key at runtime, so a lesson costs nothing to serve and behaves identically every time",
      "Built accounts, progress tracking, and a Lesson Foundry authoring pipeline that opens draft PRs a human still has to merge",
    ],
    stack: ["React", "TypeScript", "Node.js", "AWS Lambda", "CloudFront", "Claude Code"],
    spec: [
      { label: "Frontend", value: "React 19 · Vite · static SPA" },
      { label: "Backend", value: "Fastify 5 on Node 20 Lambda, behind an HTTP API" },
      { label: "Data", value: "Postgres via node-postgres, numbered SQL migrations" },
      { label: "Infra", value: "Private S3 + CloudFront (OAC) · CloudFormation · GitHub OIDC" },
      { label: "Tests", value: "node --test · Playwright e2e · CI gate on lesson-manifest drift" },
    ],
    status: "live",
    live: "https://learn.austinjuliuskim.com",
    source: "https://github.com/AustinJuliusKim/projects/tree/main/apps/guided-repl",
    onResume: true,
  },
  {
    name: "Choices",
    tagline: "A 0→1 serverless product: a two-player elimination game with AI-assisted suggestions.",
    description:
      "Pre-seed four choices, share a short code, and take turns eliminating until one wins. Built solo end-to-end: no-account guest play, Google sign-in, Stripe subscriptions, Web Push notifications, and a Claude-powered 'Fill my 4' suggestion engine for subscribers — all fully serverless.",
    highlights: [
      "Full-stack 0→1: React front-end + Node Lambda API + DynamoDB, deployed via AWS SAM",
      "Integrated Claude via Amazon Bedrock for AI-assisted choice suggestions, gated to subscribers",
      "Auth (Cognito/Google), Stripe billing, Web Push, and WAF — production-grade plumbing",
      "Event pipeline off DynamoDB Streams into an S3 lake queried with Athena; dashboards read anonymous aggregates only, never a record",
    ],
    stack: ["React", "AWS Lambda", "DynamoDB", "Amazon Bedrock", "Stripe", "Web Push"],
    spec: [
      { label: "Frontend", value: "React 19 · Vite · installable PWA" },
      { label: "Backend", value: "Node 22 Lambda Function URLs — no API Gateway on the game path" },
      { label: "Data", value: "DynamoDB single table (TTL + Streams) → S3 event lake → Athena" },
      { label: "AI", value: "Amazon Bedrock — Claude Haiku 4.5" },
      { label: "Infra", value: "AWS SAM · Cognito + Google · Stripe · Web Push (VAPID) · WAF" },
      { label: "Tests", value: "node --test, ~170 unit tests over I/O-free game logic" },
    ],
    status: "live",
    live: "https://choices.austinjuliuskim.com",
    source: "https://github.com/AustinJuliusKim/projects/tree/main/apps/choices-webapp",
    onResume: true,
  },
  {
    name: "MTG Card Database",
    tagline: "A card-similarity API built on vector search over mechanics and rules text.",
    description:
      "A read-only API over the full Magic: The Gathering card corpus that answers 'what else plays like this card?' — scored from mechanics and card text rather than crowd-sourced decklists, so it surfaces functional analogues instead of whatever is popular this season. Every result carries a calibrated confidence band and a human-readable reason.",
    highlights: [
      "Embedded the full card corpus and served nearest-neighbour lookups from Postgres with pgvector — no separate vector database to run or pay for",
      "Hybrid rescoring over the cosine candidate pool using mechanics, type and resource signals, tuned against a hand-built golden set",
      "Ingest runs unattended on a schedule, streaming the bulk data set line-by-line so it never has to fit in memory or on disk",
    ],
    stack: ["Python", "FastAPI", "AWS Lambda", "Postgres + pgvector", "Amazon Bedrock"],
    spec: [
      { label: "API", value: "Python 3.12 · FastAPI + Mangum on Lambda (SAM + HTTP API)" },
      { label: "Data", value: "Postgres + pgvector (HNSW) · ~35k oracle cards, ~110k printings" },
      { label: "Embeddings", value: "Amazon Bedrock — Titan Text Embeddings V2" },
      { label: "Ingest", value: "Scryfall bulk JSONL on a GitHub Actions cron, streamed" },
      { label: "Tests", value: "pytest · ruff · migrations dry-run in CI" },
    ],
    status: "in-progress",
    statusNote: "API live · web app in progress",
    source: "https://github.com/AustinJuliusKim/projects/tree/main/services/mtg-api",
    onResume: true,
  },
  {
    name: "MTG Collection Tooling",
    tagline: "A local-first collection manager that runs a real SQLite database in the browser.",
    description:
      "Import collection exports, then tier, de-duplicate, and price them. The web app keeps a genuine SQLite database in a Web Worker backed by the browser's origin-private file system — the data never leaves the machine, and there is no server to run. It began as a stdlib-only Python CLI, which is still the reference implementation.",
    highlights: [
      "Ported the whole storage layer to browser-resident SQLite (OPFS), with a CI job proving the browser and server implementations produce byte-identical databases",
      "Undo is the backbone, built before any mutation existed: every change writes its inverse patch in the same transaction",
      "Money is integer cents end to end, never a float — and a missing cost basis stays null instead of being invented as zero",
    ],
    stack: ["React", "TypeScript", "SQLite (WASM/OPFS)", "Python", "Cloudflare Pages"],
    spec: [
      { label: "Frontend", value: "React 19 · Mantine 9 · Vite · TypeScript" },
      { label: "Data", value: "SQLite compiled to WASM, running in a Web Worker on OPFS" },
      { label: "Library", value: "Python 3.9 CLI, stdlib-only — enforced by an AST boundary test" },
      { label: "Infra", value: "Cloudflare Pages (the rest of the portfolio is AWS)" },
      { label: "Tests", value: "Vitest · Playwright · CI parity job vs. the reference build" },
    ],
    status: "live",
    live: "https://mtg-tools.pages.dev",
    source: "https://github.com/AustinJuliusKim/projects/tree/main/mtg-tools",
  },
];

/** Required attribution for anything rendering Magic: The Gathering card data. */
export const mtgAttribution =
  "Card data via Scryfall. Portions of the materials used are property of Wizards of the Coast. © Wizards of the Coast LLC. Unofficial Fan Content permitted under the Fan Content Policy — not approved or endorsed by Wizards.";

export type Job = {
  company: string;
  role: string;
  period: string;
  bullets: string[];
};

export const experience: Job[] = [
  {
    company: "Riot Games",
    role: "Senior Software Engineer",
    period: "2021 — Present",
    bullets: [
      "Build and own internal developer-platform tooling for game playtesting — gating and managing access to game builds and artifacts for internal and public alpha/beta playtests, from company-wide (~5,000 employees) to hundreds of thousands to ~2M players.",
      "Launched the team's internal portal and grew it from ~100 monthly users at launch to thousands of daily actives.",
      "Built a reusable Portal component library and a cross-team contribution model — teams across Riot ship consistent UX, including AI-assisted contribution via agents.md/style.md conventions and smart components.",
      "Won Riot's internal Thunderdome hackathon (2025), prototyping an Unreal Engine feature for managing skin collections.",
    ],
  },
  {
    company: "Ring (Amazon)",
    role: "Software Development Engineer II",
    period: "2018 — 2021",
    bullets: [
      "Built a micro-frontend webview embedded in the Ring iOS and Android apps for privacy controls and notification settings across the company's services.",
      "Built internal B2B web tooling for the Neighbors org handling privacy-sensitive geolocation data, with encryption and data anonymization.",
      "Led and mentored a team of 3 front-end contractors for ~6 months — onboarding, coaching, and feedback.",
      "On the ML content-moderation team, built internal tooling for human moderators training automated moderation of community posts.",
    ],
  },
  {
    company: "Loot Crate",
    role: "Front-End Software Engineer",
    period: "2015 — 2018",
    bullets: [
      "Led front-end development for the on-time launch of 40+ product lines over 2+ years.",
      "Ported the front end from a Rails/CoffeeScript stack to React/Redux against a REST API.",
      "Stood up a new subscription-box e-commerce MVP for sports fans (SportsCrate) in 6 months — Ruby/Rails, Docker, Kubernetes.",
      "Ran A/B testing (Google Optimize), iterated on the CMS, and implemented designs as performant, accessible, responsive UIs.",
    ],
  },
];

export const skills: { group: string; items: string[] }[] = [
  {
    group: "Frontend & product",
    items: ["React", "TypeScript", "JavaScript", "CSS", "Design systems", "Micro-frontends", "Accessibility"],
  },
  {
    group: "Backend & AWS",
    items: ["Node.js", "AWS Lambda", "DynamoDB", "API design", "CloudFront / S3", "AWS CDK & SAM", "Serverless"],
  },
  {
    group: "AI / LLM",
    items: ["Claude API", "Amazon Bedrock", "Claude Code", "Agentic development", "Prompt engineering", "LLM app architecture"],
  },
  {
    group: "Python & data",
    items: ["Python", "FastAPI", "Postgres", "pgvector", "Embeddings & vector search"],
  },
];
