// Stripe subscription billing (premium tier). Web-only purchase surface:
// the iOS shell never links here (App Store 3.1.1) but honors the resulting
// entitlement (3.1.3). Secrets arrive via SAM parameters -> env.
//
// userId resolution in webhooks needs no lookup index: checkout sessions
// carry client_reference_id, and the subscription is created with
// metadata.userId so customer.subscription.* events carry it too.
import Stripe from "stripe";

let stripe = null;

export function billingEnabled() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function getStripe() {
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

export const PLAN_PRICES = () => ({
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  annual: process.env.STRIPE_PRICE_ANNUAL,
});

// Returns { url, customerId } — customerId so the caller can persist it on
// the USER# item the first time.
export async function createCheckoutSession(userItem, plan, siteUrl) {
  const price = PLAN_PRICES()[plan];
  if (!price) throw new BillingError(400, "Unknown plan.", "BAD_PLAN");

  const s = getStripe();
  let customerId = userItem.premium?.stripeCustomerId;
  if (!customerId) {
    const customer = await s.customers.create({
      email: userItem.email ?? undefined,
      metadata: { userId: userItem.userId },
    });
    customerId = customer.id;
  }

  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: userItem.userId,
    line_items: [{ price, quantity: 1 }],
    // metadata.plan lets the completion webhook emit sub_started with the
    // plan name (the session object itself never names the price plan).
    metadata: { plan },
    subscription_data: { metadata: { userId: userItem.userId } },
    allow_promotion_codes: true,
    // siteUrl carries a trailing slash (it's the Cognito callback URL).
    success_url: `${siteUrl}#/account?upgraded=1`,
    cancel_url: `${siteUrl}#/account`,
  });
  return { url: session.url, customerId };
}

export async function createPortalSession(userItem, siteUrl) {
  const customerId = userItem.premium?.stripeCustomerId;
  if (!customerId) {
    throw new BillingError(400, "No subscription on this account.", "NO_SUBSCRIPTION");
  }
  const session = await getStripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${siteUrl}#/account`,
  });
  return { url: session.url };
}

// In-app cancel (the cute Choicey page). Cancel at period end, not
// immediately, so the member keeps what they paid for; the resulting
// customer.subscription.updated webhook carries the same intent and the
// final .deleted event flips status to canceled when the period lapses.
// Returns the period-end so the UI can say "Premium until <date>".
export async function cancelSubscription(userItem) {
  const subId = userItem.premium?.stripeSubId;
  if (!subId) {
    throw new BillingError(400, "No active subscription to cancel.", "NO_SUBSCRIPTION");
  }
  const sub = await getStripe().subscriptions.update(subId, {
    cancel_at_period_end: true,
  });
  return {
    cancelAtPeriodEnd: true,
    currentPeriodEnd: sub.current_period_end ? sub.current_period_end * 1000 : undefined,
  };
}

// Best-effort backfill: match an existing Stripe customer by email and pull
// their live subscription, so an account that subscribed outside the app's
// own Checkout (e.g. created in the dashboard, or before the Live webhook was
// wired) can be reconciled to real customer/subscription ids — which keeps
// the in-app cancel flow working. Returns the premium patch or null.
export async function reconcileByEmail(email) {
  if (!email) return null;
  const s = getStripe();
  const customers = await s.customers.list({ email, limit: 20 });
  for (const customer of customers.data) {
    const subs = await s.subscriptions.list({
      customer: customer.id,
      status: "all",
      limit: 20,
    });
    const live = subs.data.find((sub) =>
      ["active", "trialing", "past_due"].includes(sub.status)
    );
    if (live) {
      return {
        status: normalizeStatus(live.status),
        stripeCustomerId: customer.id,
        stripeSubId: live.id,
        currentPeriodEnd: live.current_period_end
          ? live.current_period_end * 1000
          : undefined,
      };
    }
  }
  return null;
}

// Verify + normalize a webhook. Returns null for event types we don't act
// on, else { userId, premium } to merge onto the USER# item.
export function parseWebhook(rawBody, signature) {
  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch {
    throw new BillingError(400, "Bad webhook signature.", "BAD_SIGNATURE");
  }

  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
      return {
        userId: obj.client_reference_id,
        // Sessions created before metadata.plan existed simply omit it.
        plan: obj.metadata?.plan,
        premium: {
          status: "active",
          stripeCustomerId: obj.customer,
          stripeSubId: obj.subscription,
        },
      };
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const status =
        event.type === "customer.subscription.deleted"
          ? "canceled"
          : normalizeStatus(obj.status);
      return {
        userId: obj.metadata?.userId,
        premium: {
          status,
          stripeCustomerId: obj.customer,
          stripeSubId: obj.id,
          currentPeriodEnd: obj.current_period_end
            ? obj.current_period_end * 1000
            : undefined,
        },
      };
    }
    default:
      return null;
  }
}

function normalizeStatus(stripeStatus) {
  if (["active", "trialing"].includes(stripeStatus)) return "active";
  if (stripeStatus === "past_due") return "past_due";
  return "canceled";
}

export class BillingError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.code = code;
  }
}

// Test hook (same rationale as auth.mjs).
export function _setStripeForTests(fake) {
  stripe = fake;
}
