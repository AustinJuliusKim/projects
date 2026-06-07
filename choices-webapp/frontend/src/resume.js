// iOS install bridge.
//
// On iOS, an installed (Home Screen) PWA has SEPARATE localStorage from Safari
// and always launches at the manifest start_url ("/") — so the in-progress game
// id and the player's role/token are both lost on install.
//
// Cache Storage is the ONE storage area iOS shares across the Safari<->standalone
// boundary. We stash the active game's {gameId, role, token} there in Safari, then
// read it back when the installed app boots and restore identity locally.
//
// All calls are best-effort: if Cache Storage is unavailable or throws, we no-op
// so normal browser play is never affected.

const CACHE_NAME = "choices-resume";
const KEY = "/__active_game__";

export async function stashActiveGame({ gameId, role, token }) {
  try {
    if (!("caches" in window)) return;
    const cache = await caches.open(CACHE_NAME);
    const body = JSON.stringify({ gameId, role, token });
    await cache.put(KEY, new Response(body, { headers: { "content-type": "application/json" } }));
  } catch {
    /* best-effort */
  }
}

export async function readActiveGame() {
  try {
    if (!("caches" in window)) return null;
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(KEY);
    if (!res) return null;
    const data = await res.json();
    return data?.gameId ? data : null;
  } catch {
    return null;
  }
}

export async function clearActiveGame() {
  try {
    if (!("caches" in window)) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(KEY);
  } catch {
    /* best-effort */
  }
}
