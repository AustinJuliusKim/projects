import { isNative, WEB_ORIGIN } from "@/lib/platform.js";

// Invite plumbing shared by the create screen and the in-game pinned code
// (re-share after the host has taken their seat).

export function joinLink(code) {
  // Inside the native shell the location origin is capacitor://localhost —
  // recipients need the web app. The /j/ path serves an OG preview card to
  // crawlers and instantly redirects humans into the join flow.
  const base = isNative
    ? `${WEB_ORIGIN}/`
    : `${window.location.origin}${window.location.pathname}`;
  return `${base}j/${encodeURIComponent(code)}`;
}

export async function shareInvite(code) {
  const text = `You've got Choices 😏 Enter code ${code} and cut wisely.`;
  const shareData = { title: "Choices", text, url: joinLink(code) };
  if (isNative) {
    const { Share } = await import("@capacitor/share");
    try {
      await Share.share(shareData);
    } catch {
      /* sheet dismissed */
    }
    return;
  }
  if (navigator.share) {
    try {
      await navigator.share(shareData);
      return;
    } catch {
      /* cancelled -> fall through */
    }
  }
  await navigator.clipboard.writeText(`${text}\n${joinLink(code)}`);
  alert("Invite copied to clipboard!");
}
