# iOS app (Capacitor) — build & test on Apple's free tier

The iOS app is a Capacitor 8 wrap of `frontend/` (SPM — no CocoaPods). No paid
Apple Developer account is needed until App Store launch (see the vault's
Choices Growth Plan §3 Phase B for the launch checklist).

## Toolchain

- Xcode 26+ (Capacitor 8 requirement) with the iOS simulator runtime
  (`xcodebuild -downloadPlatform iOS`).
- Node ≥ 22 — `nvm use` picks up `frontend/.nvmrc` (24.15, matches CI).

## Build & run

From `frontend/`:

```sh
npm run build:ios   # vite build --mode ios + cap sync ios
npm run ios:run     # + run on a simulator (pick device when prompted)
npm run ios         # + open Xcode instead
```

`--mode ios` loads `.env.ios` (prod API URL). To develop against the preview
stack, create `.env.ios.local` (gitignored):

```
VITE_API_URL=https://<preview-cloudfront-domain>/api
```

Preview CORS is `*`, so the native origin (`capacitor://localhost`) is
accepted with no infra change. Prod allowlists it explicitly via the
`CorsAllowOrigin` parameter — **never edit that value in the AWS console**
(the UI rejects `capacitor://` schemes and would clobber it).

## Simulator

No signing or Apple ID needed. Debug the WKWebView via Safari →
Develop → Simulator → Choices.

## Physical iPhone (free "personal team" signing)

1. Xcode ▸ Settings ▸ Accounts → add your Apple ID (creates a Personal Team).
2. Open `frontend/ios/App/App.xcodeproj` → target **App** → Signing &
   Capabilities → check "Automatically manage signing" → Team: *Personal Team*.
3. iPhone: Settings → Privacy & Security → **Developer Mode** → on (reboots).
4. Run from Xcode; then on the phone trust the cert under Settings →
   General → VPN & Device Management.

Free-tier limits: provisioning profile expires every **7 days** (re-run from
Xcode to refresh), max 3 sideloaded apps, no push entitlement, no TestFlight.

## What's intentionally different in the native shell

- No service worker / Web Push (inert in WKWebView; APNs comes with the paid
  phase). Turn updates ride the existing adaptive polling.
- Invite links always use the web origin (`platform.js` `WEB_ORIGIN`), never
  `capacitor://localhost`.
- Share sheet via `@capacitor/share`; haptics on cut/winner via
  `@capacitor/haptics`; affiliate links open in SFSafariViewController via
  `@capacitor/browser`.
- "Add to Home Screen" hints are hidden (`isIosSafari()` excludes the shell).
