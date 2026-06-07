// Per-game role + token persistence in localStorage.
// Lets a player keep their identity (and authorization token) across refreshes.
const key = (gameId) => `choices:${gameId}`;

export function saveIdentity(gameId, role, token) {
  localStorage.setItem(key(gameId), JSON.stringify({ role, token }));
}

export function loadIdentity(gameId) {
  try {
    const raw = localStorage.getItem(key(gameId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
