// mtg-webapp's Mantine theme — "Void Table": near-black canvas, a single
// vivid indigo accent, clean geometric sans. The register modern
// deckbuilding sites (Moxfield, Archidekt) already use — picked after a
// live side-by-side comparison against two other candidates (see
// ~/.claude/plans/great-before-we-move-typed-globe.md for the tokens that
// didn't make the cut). Forced dark-only for now, matching the app's
// current (pre-Mantine) dark-only palette; a light mode is future scope.
import { createTheme } from "@mantine/core";

export const theme = createTheme({
  primaryColor: "indigo",
  colors: {
    indigo: [
      "#efe9fe",
      "#d7c9fc",
      "#bda5fa",
      "#a481f8",
      "#8b5cf6",
      "#7c4de3",
      "#6c3fc9",
      "#5931a3",
      "#46257e",
      "#331a5c",
    ],
    dark: [
      "#e9eaef",
      "#c2c4cf",
      "#9a9daf",
      "#71758f",
      "#54576d",
      "#3a3c4a",
      "#24262f",
      "#191a21",
      "#121319",
      "#0e0f13",
    ],
  },
  fontFamily: "Inter, system-ui, sans-serif",
  headings: { fontFamily: "Inter, system-ui, sans-serif", fontWeight: "700" },
  defaultRadius: "sm",
  radius: { sm: "8px" },
});
