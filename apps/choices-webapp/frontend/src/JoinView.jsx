import React, { useEffect, useRef, useState } from "react";
import { claimSeat, track, trackBeacon } from "./api.js";
import { saveIdentity } from "./storage.js";
import { enablePush, pushSupported } from "./push.js";
import IosInstallHint from "./IosInstallHint.jsx";
import Button from "./Button.jsx";

export default function JoinView({ prefillCode = "", onReady }) {
  const [code, setCode] = useState(prefillCode);
  // step: "code" -> enter code, "seat" -> pick Host/Guest
  const [step, setStep] = useState(prefillCode ? "seat" : "code");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Funnel beacons (bundle A). The code is sent only to `track`, where the
  // server resolves it to a pairing_ref and drops it. join_abandoned is
  // necessarily heuristic: a pagehide before any claim, sent via
  // sendBeacon so page teardown can't cancel it.
  const codeRef = useRef(code);
  codeRef.current = code;
  const claimedRef = useRef(false);
  useEffect(() => {
    if (prefillCode.trim()) {
      track("invite_link_opened", { via: "link" }, { code: prefillCode.trim() });
    }
    const onPageHide = () => {
      const c = codeRef.current.trim();
      if (!claimedRef.current && c) trackBeacon("join_abandoned", {}, { code: c });
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []); // mount-once: fires per join-screen visit, not per keystroke

  function onCodeSubmit(e) {
    e.preventDefault();
    if (!code.trim()) return;
    track("invite_link_opened", { via: "manual" }, { code: code.trim() });
    setError(null);
    setStep("seat");
  }

  async function claim(seat) {
    setError(null);
    setBusy(true);
    try {
      const res = await claimSeat(code.trim(), seat);
      claimedRef.current = true;
      saveIdentity({ pairingId: res.pairingId, role: seat, token: res.token, code: res.code });
      if (pushSupported()) {
        enablePush(res.pairingId, seat, res.token).catch(() => {});
      }
      if (onReady) onReady();
    } catch (err) {
      setError(err.message);
      setBusy(false);
      // On an invalid code, send the user back to fix it.
      if (err.code === "INVALID_CODE") setStep("code");
    }
  }

  if (step === "seat") {
    return (
      <div className="container">
        <h1>Which player are you?</h1>
        <p className="muted">
          Code <strong>{code.trim().toUpperCase()}</strong>
        </p>

        <IosInstallHint />

        <Button variant="primary" onClick={() => claim("A")} busy={busy}>
          I created this game (Host)
        </Button>
        <Button variant="primary" onClick={() => claim("B")} busy={busy}>
          I was invited (Guest)
        </Button>
        {error && <p className="error">{error}</p>}
        <Button variant="ghost" onClick={() => setStep("code")} busy={busy}>
          ← Change code
        </Button>
      </div>
    );
  }

  return (
    <div className="container">
      <h1>You've been given Choices</h1>
      <p className="muted">Enter the code and cut wisely. 😏</p>

      <IosInstallHint />

      <form onSubmit={onCodeSubmit}>
        <input
          className="choice-input code-input"
          placeholder="PLUM-42"
          value={code}
          maxLength={12}
          autoCapitalize="characters"
          autoCorrect="off"
          onChange={(e) => setCode(e.target.value)}
        />
        <Button variant="primary" type="submit" disabled={!code.trim()}>
          Next →
        </Button>
      </form>
    </div>
  );
}
