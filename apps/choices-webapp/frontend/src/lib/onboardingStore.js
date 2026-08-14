// Per-device "has seen the first-run tour" record. Deliberately NOT keyed to
// the account sub (unlike streakCache) and NOT cleared on sign-out: seeing
// the tour is device knowledge about the human, and clearing it would re-nag
// someone who just signed out. Signed-in cross-device suppression rides the
// USER# record instead (setOnboarded up, getMe's markOnboarded("synced") down).
import {
  ONBOARDING_KEY,
  parseOnboarding,
  serializeOnboarding,
} from "@/lib/onboardingCore.mjs";

export function readOnboarded() {
  return parseOnboarding(localStorage.getItem(ONBOARDING_KEY));
}

// Idempotent: an existing record (whatever its variant) is never overwritten,
// so a "synced" record can't demote an earlier explicit dismiss or vice versa.
export function markOnboarded(variant) {
  if (readOnboarded()) return;
  localStorage.setItem(ONBOARDING_KEY, serializeOnboarding(variant));
}
