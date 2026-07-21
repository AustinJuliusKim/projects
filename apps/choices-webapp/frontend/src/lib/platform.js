// Native-shell detection + canonical web origin, in one import point.
// @capacitor/core is web-safe: isNativePlatform() is false in browsers.
import { Capacitor } from "@capacitor/core";

export const isNative = Capacitor.isNativePlatform();

// Links shared OUT of the app must always point at the web app — inside the
// Capacitor shell window.location.origin is capacitor://localhost, which is
// meaningless to recipients.
export const WEB_ORIGIN =
  import.meta.env.VITE_WEB_ORIGIN || "https://choices.austinjuliuskim.com";
