import { createTheme } from "@mantine/core";

/**
 * Dark by default and only dark.
 *
 * Peak usage is a high chair at 5:45pm and a kitchen at 6am, bracketing the
 * same dim hours where a white screen is genuinely unpleasant — a sibling
 * baby app's review flagged exactly this. A theme toggle is a setting nobody
 * with a spoon in one hand is going to find.
 */
export const theme = createTheme({
  primaryColor: "violet",
  colors: {
    violet: [
      "#f3effe",
      "#ded3fc",
      "#c6b3fa",
      "#ae93f8",
      "#9a78f7",
      "#8b5cf6",
      "#7a4ce0",
      "#653dbd",
      "#4f2f95",
      "#3a226e",
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
  fontFamily: "Inter, system-ui, -apple-system, sans-serif",
  headings: { fontFamily: "Inter, system-ui, -apple-system, sans-serif", fontWeight: "700" },
  defaultRadius: "md",
});
