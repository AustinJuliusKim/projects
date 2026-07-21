import React from "react";
import { isIosSafari, isStandalone } from "@/lib/push.js";

// Shown only on iOS Safari (not yet installed). iOS requires installing the PWA
// to the Home Screen before notifications work and before the app can reopen
// from a push tap.
export default function IosInstallHint() {
  if (!isIosSafari() || isStandalone()) return null;
  return (
    <div className="ios-hint">
      <strong>📲 On iPhone — install first</strong>
      <ol>
        <li>Tap the <strong>Share</strong> icon below</li>
        <li>Choose <strong>Add to Home Screen</strong></li>
        <li>Open <strong>Choices</strong> from your Home Screen</li>
        <li>Then continue here and allow notifications</li>
      </ol>
      <p className="muted">
        Notifications and turn alerts only work from the installed app.
      </p>
    </div>
  );
}
