// Web Push helper. Wraps the `web-push` library with VAPID config from env.
import webpush from "web-push";

let configured = false;

function ensureConfigured() {
  if (configured) return;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    throw new Error("VAPID keys not configured");
  }
  webpush.setVapidDetails(
    VAPID_SUBJECT || "mailto:admin@example.com",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  configured = true;
}

// Send a push notification. Returns true on success, false on failure.
// `subscription` is the PushSubscription JSON stored from the client.
export async function sendPush(subscription, payload) {
  try {
    if (webpushImpl) {
      await webpushImpl.sendNotification(subscription, JSON.stringify(payload));
      return true;
    }
    ensureConfigured();
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    // 404/410 => subscription expired/gone. Log and move on; never block a move on push.
    console.error("push failed", err?.statusCode, err?.body || err?.message);
    return false;
  }
}

// Test hook (same rationale as auth.mjs/billing.mjs): lets handler tests
// exercise the successful-send path without VAPID keys or network.
let webpushImpl = null;
export function _setWebpushForTests(fake) {
  webpushImpl = fake;
}
