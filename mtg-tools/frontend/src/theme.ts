import { Button, Card, createTheme, Paper } from '@mantine/core'

// An arcane/parchment identity for a card-game tool, replacing Mantine's
// stock blue-on-white defaults. Everything here is Mantine's own theming
// API — no new dependencies, no custom CSS files.
//
// The two neutral palettes below are what most of the app's "designed"
// feel comes from for free: `gray` is what light mode's dimmed text,
// borders, and hover backgrounds draw from, and `dark` is the equivalent
// for dark mode's AppShell/Paper/Card chrome. Warming both means every
// existing component — nothing here overrides component internals beyond
// a few defaultProps — picks up the theme without a per-component pass.

export const theme = createTheme({
  primaryColor: 'bronze',
  // A deeper shade reads better on light parchment; a lighter one stays
  // legible on the dark-mode ink background.
  primaryShade: { light: 6, dark: 4 },

  colors: {
    // Gold/bronze accent — buttons, links, the active nav item, badges.
    bronze: [
      '#fbf1dc',
      '#f6e4be',
      '#efd093',
      '#e6ba68',
      '#dca542',
      '#d3922b',
      '#b87920',
      '#93611a',
      '#6e4913',
      '#4a310d',
    ],
    // Light-mode neutrals: parchment cream instead of Mantine's default
    // cool gray. Used broadly — dimmed text, borders, subtle backgrounds.
    gray: [
      '#faf6ee',
      '#f2ead8',
      '#e5d7b8',
      '#d3bf94',
      '#b9a276',
      '#96825c',
      '#786a4c',
      '#5c503a',
      '#453b2b',
      '#2e271c',
    ],
    // Dark-mode chrome: deep ink/umber instead of Mantine's default cool
    // slate. AppShell body, Paper/Card surfaces, and dark-mode text all
    // draw from this scale.
    dark: [
      '#d8cdb8',
      '#bdb094',
      '#a3947a',
      '#6b5f4d',
      '#4a4033',
      '#3a3226',
      '#2f2820',
      '#241f18',
      '#191510',
      '#100d09',
    ],
  },

  // A serif for headings only — body text and the data-dense tables
  // (Collection, Sealed) keep Mantine's default sans for density and
  // readability. This is the single biggest lever for "card-game tool"
  // over "generic SaaS dashboard."
  headings: {
    fontFamily:
      '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
    fontWeight: '600',
  },

  defaultRadius: 'md',

  // Warm-tinted shadows (ink, not pure black) so elevation reads as part
  // of the same palette rather than a generic default.
  shadows: {
    xs: '0 1px 2px rgba(46, 39, 28, 0.08)',
    sm: '0 2px 6px rgba(46, 39, 28, 0.10)',
    md: '0 4px 12px rgba(46, 39, 28, 0.12)',
    lg: '0 8px 24px rgba(46, 39, 28, 0.14)',
    xl: '0 16px 40px rgba(46, 39, 28, 0.16)',
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
