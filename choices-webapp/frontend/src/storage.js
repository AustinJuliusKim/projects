// Persistent player identity for the pairing (survives across all games).
// One record per device: { pairingId, role, token }.
const KEY = "choices:identity";

export function saveIdentity({ pairingId, role, token }) {
  localStorage.setItem(KEY, JSON.stringify({ pairingId, role, token }));
}

export function loadIdentity() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearIdentity() {
  localStorage.removeItem(KEY);
}
