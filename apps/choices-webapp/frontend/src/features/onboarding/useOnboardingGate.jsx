import React, { useEffect, useState } from "react";
import { useFlag, useFlagsHydrated } from "@/lib/flags.jsx";
import { authEnabled, hasSession } from "@/lib/auth.js";
import { readOnboarded, markOnboarded } from "@/lib/onboardingStore.js";
import { onboardingSurface, decideOnboarding } from "@/lib/onboardingCore.mjs";
import { setOnboarded, trackBeacon } from "@/lib/api.js";
import { fetchMe } from "@/hooks/useMe.js";
import OnboardingOverlay from "@/features/onboarding/OnboardingOverlay.jsx";

// How long a signed-in "is this account already onboarded?" check may hold
// the overlay back before failing open to showing it.
const SERVER_CHECK_TIMEOUT_MS = 2000;

export function useOnboardingGate({ hash, identity }) {
  const flagOn = useFlag("release_onboarding");
  const hydrated = useFlagsHydrated();
  const signedIn = authEnabled && hasSession();
  // undefined = in flight, null = fetch failed (fail open), boolean = answer.
  const [serverOnboarded, setServerOnboarded] = useState(undefined);
  // Re-read localStorage after a dismiss without a storage-event dance.
  const [, bump] = useState(0);

  const surface = onboardingSurface(hash, !!identity);
  const decision = decideOnboarding({
    surface,
    record: readOnboarded(),
    flagOn,
    hydrated,
    signedIn,
    serverOnboarded,
  });

  // Only the signed-in "wait" state needs the server's answer. fetchMe is the
  // shared useMe cache, so this never duplicates a request a view already
  // started; the timeout keeps a slow network from holding onboarding hostage.
  const needServer = decision === "wait" && hydrated && signedIn;
  useEffect(() => {
    if (!needServer) return;
    let alive = true;
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), SERVER_CHECK_TIMEOUT_MS)
    );
    Promise.race([fetchMe(), timeout])
      .then((data) => alive && setServerOnboarded(!!data?.onboarded))
      .catch(() => alive && setServerOnboarded(null));
    return () => {
      alive = false;
    };
  }, [needServer]);

  function dismiss(outcome, { variant, lastStep }) {
    markOnboarded(variant);
    if (signedIn) setOnboarded().catch(() => {});
    trackBeacon("onboarding_dismissed", {
      variant,
      outcome,
      last_step: lastStep,
    });
    bump((n) => n + 1);
  }

  return { surface, visible: decision === "show", dismiss };
}

// Thin mount wrapper so App() stays a flat list of siblings and all hook
// logic lives here rather than in main.jsx.
export function Onboarding({ hash, identity }) {
  const { surface, visible, dismiss } = useOnboardingGate({ hash, identity });
  if (!visible) return null;
  return <OnboardingOverlay surface={surface} onDismiss={dismiss} />;
}
