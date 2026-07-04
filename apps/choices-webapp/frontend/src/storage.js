// Persistent player identity for the pairing (survives across all games).
// One record per device: { pairingId, role, token, code }. The join code is
// kept here because getState responses are edge-cached and no longer carry it.
const KEY = "choices:identity";

export function saveIdentity({ pairingId, role, token, code }) {
  localStorage.setItem(KEY, JSON.stringify({ pairingId, role, token, code }));
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
