import { Button, Card, createTheme, Paper } from '@mantine/core'

// "Ledger Dark" — after Mercury's banking UI: a near-black canvas, one
// vivid cobalt accent reserved for primary actions, and desaturated
// semantic color so gains/losses/review states read calmly rather than
// shouting. Picked over an earlier arcane/parchment pass after reviewing
// three fintech-inspired directions side by side (Mercury / Wealthfront /
// Carta) — see PR #82's history for the others.
//
// Everything here is Mantine's own theming API — no new dependencies.
// `gray` (light mode) and `dark` (dark mode) are what most of the app's
// look comes from for free: dimmed text, borders, Paper/Card/AppShell
// surfaces all draw from these, so existing screens inherit the theme
// without a per-component pass. Deliberately cool-neutral (a faint
// blue-violet bias toward the cobalt accent) rather than a default gray.

export const theme = createTheme({
  primaryColor: 'cobalt',
  // A deeper shade reads better on light paper; the lighter, punchier
  // shade — the exact hero color from the concept review — pops on the
  // near-black dark background.
  primaryShade: { light: 6, dark: 5 },

  colors: {
    // Cobalt accent — reserved for primary actions and the active nav
    // item, not sprinkled everywhere (that restraint is the point of
    // this direction, same as Mercury's own single-accent rule).
    cobalt: [
      '#eef0ff',
      '#dbe0ff',
      '#b7c0ff',
      '#96a3ff',
      '#7a89ff',
      '#5468ff',
      '#4453e0',
      '#3540b8',
      '#282f8f',
      '#1c2166',
    ],
    // Light-mode neutrals: cool paper with a faint blue-violet bias
    // toward the accent, instead of Mantine's default neutral gray.
    gray: [
      '#f6f6f9',
      '#ececf2',
      '#d8d9e3',
      '#bfc0cf',
      '#9fa1b5',
      '#82849b',
      '#676980',
      '#505267',
      '#3a3b4d',
      '#232433',
    ],
    // Dark-mode chrome: Mercury's near-black ink and graphite panels,
    // not Mantine's default cool slate. index 9 ≈ body bg, 7 ≈ Paper/
    // AppShell surfaces, 3 ≈ dimmed text, 0 ≈ primary text — all pulled
    // directly from the reviewed concept's tokens.
    dark: [
      '#edeef4',
      '#c7c9d6',
      '#a7a9bd',
      '#8d8fa3',
      '#5c5e75',
      '#3a3c4d',
      '#2a2b37',
      '#1b1c25',
      '#16161d',
      '#131319',
    ],
  },

  // A tight, confident system grotesk for headings (weight 800) — the
  // "serious operator" register this direction is going for. Body text
  // uses the same family at normal weight, matching Mantine's own
  // default stack closely but pinned explicitly rather than inherited.
  fontFamily: 'ui-sans-serif, "Inter", "Helvetica Neue", Arial, sans-serif',
  headings: {
    fontFamily: 'ui-sans-serif, "Inter", "Helvetica Neue", Arial, sans-serif',
    fontWeight: '800',
  },

  defaultRadius: 'md',
  radius: { md: '8px' },

  // Cool near-black shadow tint (not warm) to match the palette.
  shadows: {
    xs: '0 1px 2px rgba(10, 10, 16, 0.10)',
    sm: '0 2px 6px rgba(10, 10, 16, 0.14)',
    md: '0 4px 14px rgba(10, 10, 16, 0.16)',
    lg: '0 10px 28px rgba(10, 10, 16, 0.18)',
    xl: '0 18px 44px rgba(10, 10, 16, 0.20)',
  },

  components: {
    // Every existing call site already passes `withBorder`/`radius`
    // explicitly where it matters — these are just the fallback for the
    // few that don't, so nothing regresses.
    Paper: Paper.extend({
      defaultProps: { radius: 'md' },
    }),
    Card: Card.extend({
      defaultProps: { withBorder: true, radius: 'md' },
    }),
    Button: Button.extend({
      defaultProps: { radius: 'md' },
    }),
  },
})
