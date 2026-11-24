# Pixel font (optional)

The UI declares `@font-face { font-family: "Pixel"; src: url(/fonts/pixel.woff2) }`
and falls back to `"Courier New", monospace` when the file is absent, so the
game works without it.

To get the full 8-bit look, drop an OFL-licensed pixel font here as
`pixel.woff2` — e.g. Press Start 2P:
https://fonts.google.com/specimen/Press+Start+2P (download, convert the TTF to
woff2, rename). Keep it local; the app must not load fonts from a CDN at
runtime.
