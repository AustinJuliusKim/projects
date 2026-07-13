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
  "At Riot Games I build internal developer platforms and tooling for game playtesting — the systems teams use to gate access to builds and run internal and public alpha/beta tests, from company-wide to player pools in the millions. I also built a shared Portal component library and a cross-team contribution model so teams across Riot ship consistent UX.",
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
    source: "https://github.com/AustinJuliusKim/projects/tree/main/apps/guided-repl",
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
    source: "https://github.com/AustinJuliusKim/projects/tree/main/apps/choices-webapp",
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
    role: "Senior Software Engineer (promoted from Software Engineer, 2023)",
    period: "2021 — Present",
    bullets: [
      "Build and own internal developer-platform tooling for game playtesting — gating and managing access to game builds and artifacts for internal and public alpha/beta playtests, from company-wide (~5,000 employees) to external player pools of hundreds of thousands to ~2M players.",
      "Launched the team's internal portal and grew it from ~100 monthly users at launch to thousands of daily actives.",
      "Built a reusable Portal component library and a cross-team contribution model — teams across Riot ship consistent UX, including AI-assisted contribution via agents.md/style.md conventions and smart components.",
      "Won Riot's internal Thunderdome hackathon (2025), prototyping an Unreal Engine feature for managing skin collections.",
    ],
  },
  {
    company: "Ring (Amazon)",
    role: "Software Development Engineer",
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
];
