// Service worker registration + Web Push subscription helpers.
import { subscribe as apiSubscribe, track } from "@/lib/api.js";
import { isNative } from "@/lib/platform.js";

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export function pushSupported() {
  // Web Push never applies in the Capacitor shell (no SW; APNs is a future
  // native path). The feature checks would be false there anyway.
  return !isNative && "serviceWorker" in navigator && "PushManager" in window;
}

// iOS *browser* detection: gates the "Add to Home Screen" hints, which make
// no sense inside the native app (its UA also matches iPhone/iPad).
export function isIosSafari() {
  const ua = window.navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua);
  return iOS && !isNative;
}

export function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch (e) {
    console.error("SW registration failed", e);
    return null;
  }
}

// Ask permission, subscribe, and persist the subscription on the server.
// Scoped to the PAIRING so notifications work across rematches.
// Returns true if a subscription was registered.
export async function enablePush(pairingId, role, token) {
  if (!pushSupported() || !VAPID_PUBLIC_KEY) return false;

  const hadPrompt = Notification.permission === "default";
  const permission = await Notification.requestPermission();
  // Beacon only actual prompt outcomes — already-granted/denied sessions
  // would otherwise re-report on every enablePush call.
  if (hadPrompt) {
    track("push_permission_result", { result: permission }, { pairingId, role, token });
  }
  if (permission !== "granted") return false;

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }
  await apiSubscribe(pairingId, role, token, sub.toJSON());
  return true;
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
