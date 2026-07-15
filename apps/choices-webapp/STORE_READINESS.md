# Choices — App Store / Play Store readiness (at a glance)

_Assessment date: 2026-07-15. Scope: `frontend/` UX only. No app-code changes were made for this report (assessment-only, per session decision). Palette stays indigo/slate._

## Verdict

**~80% store-ready.** Choices is genuinely mobile-first — it is *not* a desktop web app squeezed onto a phone. It already ships the Capacitor iOS shell, safe-area insets, a PWA manifest with real icons, native haptics, and full reduced-motion handling. The gaps that keep it from feeling "native at a glance" are small and mechanical: **touch-target sizes, button/element consistency, and press/focus feedback.** The one true *launch* blocker (for a paid iOS release) is **In-App Purchase** — Premium is web-only Stripe today.

## Scorecard

| Dimension | Status | Note |
|---|---|---|
| Mobile-first foundation | 🟢 Strong | Capacitor 8, `viewport-fit=cover`, safe-area insets throughout, `touch-action: manipulation`, PWA `standalone` |
| Assets / icons / manifest | 🟢 Strong | favicon, apple-touch, 192/512 icons, opaque `#141630` iOS bg — already installed |
| Feedback & motion | 🟢 Good | `:active` scale on `.btn`/pins, 3D flip→cross-fade under reduced-motion, haptics on cut/win |
| Accessibility | 🟢 Good | reduced-motion, aria labels on pins; **gap:** no visible `:focus-visible` ring |
| Touch targets | 🟡 Needs work | `.link-btn` (Sign out, footer Back) is 4px padding / 0.85rem — well under 44pt; `.btn`/`.chip` have no `min-height` |
| Button / element consistency | 🟡 Needs work | No shared `Button`; `← Back` is an `<a>` in most views but `Sign out` is a `<button>` |
| Navigation model | 🟡 OK | Floating corner pills only; no persistent nav/back bar or hardware-back handling |
| Store compliance (IAP) | 🔴 Blocker (paid launch) | Premium sells via web Stripe; App Store 3.1.1 requires StoreKit IAP to sell in-app |

## What's already strong (keep it)

- **Mobile-first, not ported.** `index.html` sets `viewport-fit=cover` + the full Apple PWA meta set; `.container` uses `env(safe-area-inset-*)`; `corner-tools` respects the top inset. `theme-color #0f172a`.
- **Touch tuning globally:** `-webkit-tap-highlight-color: transparent`, `user-select: none`, `touch-action: manipulation`, `overscroll-behavior: none`.
- **Native niceties:** haptics wired in `PlayView` (impact on cut, success on winner); reduced-motion replaces the 3D flip with a cross-fade; skeleton loaders (`PlayViewSkeleton`, `AccountSkeleton`, `AdminSkeleton`).
- **Design tokens** exist at `styles.css:1-18` (indigo/slate). Restyling is centralized in one stylesheet.

## Recommendations (prioritized)

### P0 — quick, high-leverage native polish (a few hours; no palette change)
1. **Introduce a shared `Button` / `NavButton` primitive.** One component that renders `<a>` or `<button>` correctly (nav vs action), guarantees `min-height: 44px`, and standardizes `:active` scale + `:focus-visible` ring. Consolidates the ~5 duplicated button patterns and fixes the `← Back` (`<a>`) vs `Sign out` (`<button>`) inconsistency.
   - Files today: `Landing.jsx`, `CreatePairingView.jsx:161`, `JoinView.jsx:104`, `AccountView.jsx` footer, `AdminView.jsx:77`.
2. **Enforce ≥44pt touch targets.** Add `min-height: 44px` to `.btn`, `.chip`, and especially `.link-btn` (currently 4px padding). This directly fixes the "Back / Sign Out links are hard to tap" instinct — the correct fix is size, and ideally making nav items real buttons.
3. **Add a `:focus-visible` ring** to interactive elements (keyboard + switch-control accessibility; also a Play Store expectation).
4. **Tokenize hard-coded borders.** `#334155` appears literally in ~6 rules (`.btn.ghost`, `.link-box`, `.rematch`, `.footer`, …) instead of `var(--border)`. Do this before any restyle so a palette tweak is one line.

> The Premium badge, Choicey cancel page, and admin controls added in this same PR were **built to this P0 standard** (44pt secondary actions, `.btn.danger`/`.btn.primary`, token-based colors) — use them as the reference pattern when rolling the primitive out app-wide.

### P1 — more native feel (larger)
5. **Persistent native nav chrome.** Replace the floating corner pills with a proper top nav/back bar and wire **hardware-back** handling (Android back button, iOS edge-swipe) via the Capacitor App plugin. Today back is per-screen `href="#/"`.
6. **Larger-screen / tablet layout.** Everything is a single 480px column; fine for phones, but iPad review appreciates a considered layout.

### P2 — the real launch gate
7. **In-App Purchase for the paid app.** Premium currently uses web Stripe, which is correctly **hidden in the Capacitor shell** (App Store 3.1.1). To *sell* Premium inside the iOS/Android app you must add **StoreKit / Play Billing** and honor the entitlement (3.1.3). This is already a known, deferred Phase-B decision — flagging it as the #1 blocker before a paid store launch. (A free-tier build ships today without it.)

## One-line summary for the store listing readiness call

Ship-ready as a **free-tier** app after the P0 polish pass; **paid** launch is gated on IAP (P2). Nothing here requires touching the color palette.
