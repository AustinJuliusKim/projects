// Single source of truth for site content.
// Edit this file to update copy. Anything marked [confirm] needs a real figure
// from Austin before the site goes live.

export const profile = {
  name: "Austin Kim",
  // The one-liner thesis, shown in the hero.
  tagline: "Senior software engineer building AI-native developer & learning tools.",
  // A slightly longer positioning line under the tagline.
  subtitle:
    "9 years shipping React + AWS at scale — Loot Crate, Ring/Amazon, Riot Games. Now building products on top of Claude.",
  location: "Los Angeles, CA · Open to remote",
  email: "austinjuliuskim@gmail.com",
  links: {
    github: "https://github.com/AustinJuliusKim",
    linkedin: "https://www.linkedin.com/in/austinjuliuskim/",
    resume: "/resume",
  },
};

export const about = [
  "I'm a product-minded engineer with roughly nine years shipping user-facing web software. I started in front-end at Loot Crate, migrated a legacy Rails/CoffeeScript app to modern React, then spent three years at Ring (Amazon) building micro-frontends embedded in the Ring iOS and Android apps on AWS CDK.",
  "For the last few years at Riot Games I've built internal tooling for live-service and R&D game teams — the kind of high-leverage tools a small number of people use every day to move fast.",
  "Since late 2025 I've gone deep on building with LLMs: agentic development with Claude Code, and shipping my own AI-native products — a platform that teaches Claude Code by replaying real sessions, and a live consumer app with Claude-powered features. This site and both projects are things I designed, built, and deployed end-to-end.",
];

export type Project = {
  name: string;
  tagline: string;
  description: string;
  highlights: string[];
  stack: string[];
  live?: string;
  source?: string;
};

export const projects: Project[] = [
  {
    name: "Guided REPL",
    tagline: "An AI-native learning platform that teaches Claude Code by replaying real sessions.",
    description:
      "A browser playground that walks you through real, recorded Claude Code (`claude -p`) runs frame-by-frame — a split-pane CLI plus a live workspace — turning an opaque agent into something you can actually learn. Eight guided lessons cover the prompt ladder, plan mode, permission modes, reading diffs, CLAUDE.md, and cost/model tradeoffs.",
    highlights: [
      "Designed a frame/fixture protocol and a seeder CLI that records real Claude Code runs into replayable fixtures",
      "Built accounts, progress tracking, and a Lesson Foundry authoring flow",
      "Shipped as a static React SPA + Node/AWS Lambda API on S3 + CloudFront",
    ],
    stack: ["React", "TypeScript", "Node.js", "AWS Lambda", "CloudFront", "Claude Code"],
    live: "https://learn.austinjuliuskim.com",
    source: "https://github.com/AustinJuliusKim", // [confirm] exact repo URL
  },
  {
    name: "Choices",
    tagline: "A 0→1 serverless product: a two-player elimination game with AI-assisted suggestions.",
    description:
      "Pre-seed four choices, share a short code, and take turns eliminating until one wins. Built solo end-to-end: no-account guest play, Google sign-in, Stripe subscriptions, Web Push notifications, and a Claude-powered 'fill my four' suggestion engine — all fully serverless and running on the free tier.",
    highlights: [
      "Full-stack 0→1: React front-end + Node Lambda API + DynamoDB, deployed via AWS SAM",
      "Integrated Claude (via Amazon Bedrock) for AI-assisted choice suggestions",
      "Auth (Cognito/Google), Stripe billing, Web Push, and WAF — production-grade plumbing",
    ],
    stack: ["React", "AWS Lambda", "DynamoDB", "Amazon Bedrock", "Stripe", "Web Push"],
    live: "https://choices.austinjuliuskim.com",
    source: "https://github.com/AustinJuliusKim", // [confirm] exact repo URL
  },
];

export type Job = {
  company: string;
  role: string;
  period: string;
  bullets: string[];
};

export const experience: Job[] = [
  {
    company: "Riot Games",
    role: "Software Engineer", // [confirm] exact title
    period: "2021 — Present",
    bullets: [
      "Build internal tooling used daily by live-service and R&D game teams to ship and operate faster.",
      "Own front-end and full-stack surfaces end-to-end, from prototype to production. [confirm impact/scale]",
    ],
  },
  {
    company: "Ring (Amazon)",
    role: "Front-End Engineer", // [confirm] exact title
    period: "2018 — 2021",
    bullets: [
      "Built and deployed micro-frontends embedded in the Ring iOS and Android mobile apps.",
      "Worked in AWS CDK to define and ship front-end infrastructure. [confirm scale/users]",
    ],
  },
  {
    company: "Loot Crate",
    role: "Front-End Engineer", // [confirm] exact title
    period: "2016 — 2018",
    bullets: [
      "Migrated a legacy Ruby on Rails / CoffeeScript application to a modern React 15 front-end.",
      "Shipped customer-facing e-commerce features at subscription-box scale. [confirm scale]",
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
];
