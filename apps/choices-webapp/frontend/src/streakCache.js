// Last-known streak from getMe responses, so the corner affordance can show
// a flame with zero extra API calls. Keyed to the account's sub — a cached
// value from another account never leaks across sign-ins.
const STREAK_KEY = "choices:streak";

export function writeStreak(sub, stats, premium = false) {
  if (!sub || !stats) return;
  localStorage.setItem(
    STREAK_KEY,
    JSON.stringify({
      sub,
      currentStreak: stats.currentStreak ?? 0,
      streakLocked: !!stats.streakLocked,
      premium: !!premium,
      at: Date.now(),
    })
  );
}

export function readStreak(sub) {
  try {
    const cached = JSON.parse(localStorage.getItem(STREAK_KEY));
    return cached && cached.sub === sub ? cached : null;
  } catch {
    return null;
  }
}

export function clearStreak() {
  localStorage.removeItem(STREAK_KEY);
}
