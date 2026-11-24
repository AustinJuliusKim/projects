// Studio branding and shared copy. The name is a placeholder: change it in
// src/studio-copy.json (also read by scripts/prerender.mjs) and it flows
// through the page, the prerendered head, and the lead form.
import copy from "./studio-copy.json";

export const STUDIO_NAME: string = copy.name;
export const STUDIO_TAGLINE: string = copy.tagline;
export const STUDIO_URL = "https://austinjuliuskim.com/studio";
export const STUDIO_TITLE = `${STUDIO_NAME} — Web, networking & security for Glendale-area small businesses`;
export const CHECKLIST_HREF = "/studio/small-business-tech-checklist.pdf";
export { copy as studioCopy };
