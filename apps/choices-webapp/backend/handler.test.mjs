// Handler-level tests: routing, idempotency, and cache-safety invariants.
// DynamoDB is mocked (aws-sdk-client-mock); push is exercised through its
// no-VAPID failure path (sendPush swallows errors by design).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { handler } from "./handler.mjs";
import { createGame, applyElimination } from "./game.mjs";
import { _setVerifierForTests } from "./auth.mjs";
import { _setStripeForTests } from "./billing.mjs";

// Fake Cognito verifier: token "good-token" -> user u-1; anything else throws.
function fakeVerifier() {
  return {
    verify: async (token) => {
      if (token !== "good-token") throw new Error("bad token");
      return { sub: "u-1", email: "u1@example.com", name: "U One" };
    },
  };
}

const ddbMock = mockClient(DynamoDBDocumentClient);

const CHOICES = ["Pizza", "Tacos", "Sushi", "Ramen"];

function pairingItem(overrides = {}) {
  return {
    pk: "PAIR#abc123",
    code: "PLUM-42",
    tokenA: "tok-a",
    tokenB: "tok-b",
    gameNumber: 1,
    nextStarter: "B",
    game: createGame(CHOICES, { startedBy: "A", number: 1 }),
    version: 3,
    createdAt: 0,
    updatedAt: 0,
    ttl: 0,
    ...overrides,
  };
}

const postEvent = (body, headers = {}) => ({
  requestContext: { http: { method: "POST" } },
  headers,
  body: JSON.stringify(body),
});
const getEvent = (queryStringParameters, headers = {}) => ({
  requestContext: { http: { method: "GET" } },
  headers,
  queryStringParameters,
});

function conditionalCheckError() {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  return err;
}

beforeEach(() => {
  ddbMock.reset();
  delete process.env.ENFORCE_ORIGIN_HEADER;
  delete process.env.ORIGIN_VERIFY_SECRET;
  delete process.env.STRIPE_SECRET_KEY;
  process.env.USER_POOL_ID = "pool";
  process.env.USER_POOL_CLIENT_ID = "client";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  _setVerifierForTests(fakeVerifier());
  _setStripeForTests(null);
});

test("GET getState works and never exposes the code", async () => {
  ddbMock.on(GetCommand).resolves({ Item: pairingItem() });

  const res = await handler(
    getEvent({ action: "getState", pairingId: "abc123", role: "A", token: "tok-a" })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "no-cache");
  const data = JSON.parse(res.body);
  assert.equal(data.state.code, undefined); // cache-safety invariant
  assert.equal(data.state.gameNumber, 1);
  assert.equal(data.state.bothJoined, true);
});

test("GET only routes getState", async () => {
  const res = await handler(
    getEvent({ action: "eliminate", pairingId: "abc123", role: "A", token: "tok-a" })
  );
  assert.equal(res.statusCode, 400);
});

test("POST getState still works (transition path)", async () => {
  ddbMock.on(GetCommand).resolves({ Item: pairingItem() });

  const res = await handler(
    postEvent({ action: "getState", pairingId: "abc123", role: "B", token: "tok-b" })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).state.code, undefined);
});

test("eliminate writes conditionally, bumps version, records actionId", async () => {
  ddbMock.on(GetCommand).resolves({ Item: pairingItem() });
  ddbMock.on(PutCommand).resolves({});

  const res = await handler(
    postEvent({
      action: "eliminate",
      pairingId: "abc123",
      role: "B",
      token: "tok-b",
      gameNumber: 1,
      index: 0,
      actionId: "aid-1",
    })
  );
  assert.equal(res.statusCode, 200);
  const put = ddbMock.commandCalls(PutCommand)[0].args[0].input;
  assert.equal(put.Item.version, 4);
  assert.equal(put.Item.lastActionId, "aid-1");
  assert.equal(put.ConditionExpression, "version = :v");
  assert.deepEqual(put.ExpressionAttributeValues, { ":v": 3 });
  assert.deepEqual(put.Item.game.eliminated.map((e) => e.index), [0]);
});

test("duplicate eliminate (same actionId) replays stored state, no write", async () => {
  // The first attempt already landed: index 0 eliminated, lastActionId set.
  // Re-applying would throw ALREADY_ELIMINATED — replay must short-circuit.
  const applied = pairingItem({ lastActionId: "aid-1", version: 4 });
  applied.game = applyElimination(applied.game, "B", 0);
  ddbMock.on(GetCommand).resolves({ Item: applied });

  const res = await handler(
    postEvent({
      action: "eliminate",
      pairingId: "abc123",
      role: "B",
      token: "tok-b",
      gameNumber: 1,
      index: 0,
      actionId: "aid-1",
    })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(ddbMock.commandCalls(PutCommand).length, 0);
  const eliminated = JSON.parse(res.body).state.game.eliminated;
  assert.deepEqual(eliminated.map((e) => e.index), [0]);
});

test("eliminate retries once after losing a write race", async () => {
  // Fresh item per load: the handler mutates in place, and a shared mock
  // object would make the retry look like a replay.
  ddbMock.on(GetCommand).callsFake(() => ({ Item: pairingItem() }));
  ddbMock.on(PutCommand).rejectsOnce(conditionalCheckError()).resolves({});

  const res = await handler(
    postEvent({
      action: "eliminate",
      pairingId: "abc123",
      role: "B",
      token: "tok-b",
      gameNumber: 1,
      index: 0,
      actionId: "aid-1",
    })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(ddbMock.commandCalls(PutCommand).length, 2);
});

test("eliminate gives up with 409 WRITE_CONFLICT after two lost races", async () => {
  ddbMock.on(GetCommand).callsFake(() => ({ Item: pairingItem() }));
  ddbMock.on(PutCommand).rejects(conditionalCheckError());

  const res = await handler(
    postEvent({
      action: "eliminate",
      pairingId: "abc123",
      role: "B",
      token: "tok-b",
      gameNumber: 1,
      index: 0,
    })
  );
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).code, "WRITE_CONFLICT");
});

// Pairing whose game is one elimination away from completing (B to move).
function nearlyWonPairing(overrides = {}) {
  const p = pairingItem(overrides);
  p.game = applyElimination(p.game, "B", 0);
  p.game = applyElimination(p.game, "A", 1);
  return p;
}

test("winning eliminate archives the game atomically with the pairing save", async () => {
  ddbMock.on(GetCommand).resolves({ Item: nearlyWonPairing() });
  ddbMock.on(TransactWriteCommand).resolves({});

  const res = await handler(
    postEvent({
      action: "eliminate",
      pairingId: "abc123",
      role: "B",
      token: "tok-b",
      gameNumber: 1,
      index: 2,
      actionId: "aid-win",
    })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(ddbMock.commandCalls(PutCommand).length, 0);

  const tx = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
  assert.equal(tx.TransactItems.length, 2);

  const pairingPut = tx.TransactItems[0].Put;
  assert.equal(pairingPut.Item.pk, "PAIR#abc123");
  assert.equal(pairingPut.Item.version, 4);
  assert.equal(pairingPut.ConditionExpression, "version = :v");
  assert.equal(pairingPut.Item.game.status, "complete");

  const archive = tx.TransactItems[1].Put.Item;
  assert.equal(archive.pk, "GAME#abc123#1");
  assert.equal(archive.pairingId, "abc123");
  assert.equal(archive.winnerIndex, 3);
  assert.equal(archive.winnerLabel, "Ramen");
  assert.equal(archive.eliminated.length, 3);
  assert.deepEqual(archive.players, { A: null, B: null });
  assert.ok(archive.ttl > 0);
});

test("mid-game eliminate stays on the plain conditional put", async () => {
  ddbMock.on(GetCommand).resolves({ Item: pairingItem() });
  ddbMock.on(PutCommand).resolves({});

  const res = await handler(
    postEvent({
      action: "eliminate",
      pairingId: "abc123",
      role: "B",
      token: "tok-b",
      gameNumber: 1,
      index: 0,
    })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(ddbMock.commandCalls(TransactWriteCommand).length, 0);
  assert.equal(ddbMock.commandCalls(PutCommand).length, 1);
});

test("winning eliminate retries after losing the transactional write race", async () => {
  const txCancelled = new Error("Transaction cancelled");
  txCancelled.name = "TransactionCanceledException";
  txCancelled.CancellationReasons = [{ Code: "ConditionalCheckFailed" }, { Code: "None" }];

  ddbMock.on(GetCommand).callsFake(() => ({ Item: nearlyWonPairing() }));
  ddbMock.on(TransactWriteCommand).rejectsOnce(txCancelled).resolves({});

  const res = await handler(
    postEvent({
      action: "eliminate",
      pairingId: "abc123",
      role: "B",
      token: "tok-b",
      gameNumber: 1,
      index: 2,
      actionId: "aid-win",
    })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(ddbMock.commandCalls(TransactWriteCommand).length, 2);
});

test("transaction cancelled for a non-version reason is not retried", async () => {
  const txCancelled = new Error("Transaction cancelled");
  txCancelled.name = "TransactionCanceledException";
  txCancelled.CancellationReasons = [{ Code: "None" }, { Code: "TransactionConflict" }];

  ddbMock.on(GetCommand).callsFake(() => ({ Item: nearlyWonPairing() }));
  ddbMock.on(TransactWriteCommand).rejects(txCancelled);

  const res = await handler(
    postEvent({
      action: "eliminate",
      pairingId: "abc123",
      role: "B",
      token: "tok-b",
      gameNumber: 1,
      index: 2,
    })
  );
  assert.equal(res.statusCode, 500);
  assert.equal(ddbMock.commandCalls(TransactWriteCommand).length, 1);
});

test("claimSeat still returns the code at the top level (state stays clean)", async () => {
  ddbMock
    .on(GetCommand, { Key: { pk: "CODE#PLUM-42" } })
    .resolves({ Item: { pk: "CODE#PLUM-42", pairingId: "abc123" } });
  ddbMock
    .on(GetCommand, { Key: { pk: "PAIR#abc123" } })
    .resolves({ Item: pairingItem({ tokenB: null }) });
  ddbMock.on(GetCommand, { Key: { pk: "SUB#abc123#A" } }).resolves({});
  ddbMock.on(PutCommand).resolves({});

  const res = await handler(postEvent({ action: "claimSeat", code: "plum-42", seat: "B" }));
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.code, "PLUM-42");
  assert.ok(data.token);
  assert.equal(data.state.code, undefined);
});

test("signed-in claimSeat links the seat; anonymous claim unlinks it", async () => {
  ddbMock
    .on(GetCommand, { Key: { pk: "CODE#PLUM-42" } })
    .resolves({ Item: { pk: "CODE#PLUM-42", pairingId: "abc123" } });
  ddbMock
    .on(GetCommand, { Key: { pk: "PAIR#abc123" } })
    .callsFake(() => ({ Item: pairingItem({ tokenB: null, userB: "old-user" }) }));
  ddbMock.on(GetCommand, { Key: { pk: "SUB#abc123#A" } }).resolves({});
  ddbMock.on(PutCommand).resolves({});

  const signedIn = await handler(
    postEvent(
      { action: "claimSeat", code: "PLUM-42", seat: "B" },
      { authorization: "Bearer good-token" }
    )
  );
  assert.equal(signedIn.statusCode, 200);
  let saved = ddbMock.commandCalls(PutCommand).at(-1).args[0].input.Item;
  assert.equal(saved.userB, "u-1");

  const anon = await handler(postEvent({ action: "claimSeat", code: "PLUM-42", seat: "B" }));
  assert.equal(anon.statusCode, 200);
  saved = ddbMock.commandCalls(PutCommand).at(-1).args[0].input.Item;
  assert.equal(saved.userB, null); // takeover unlinks the previous account
});

test("an invalid token is a hard 401, never a silent guest downgrade", async () => {
  const res = await handler(
    postEvent(
      { action: "claimSeat", code: "PLUM-42", seat: "B" },
      { authorization: "Bearer forged" }
    )
  );
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).code, "BAD_ID_TOKEN");
});

test("winning eliminate folds stats into linked users, once per distinct user", async () => {
  // Both seats held by the same account (two devices) — one stats update.
  ddbMock
    .on(GetCommand, { Key: { pk: "PAIR#abc123" } })
    .resolves({ Item: nearlyWonPairing({ userA: "u-1", userB: "u-1" }) });
  ddbMock.on(GetCommand, { Key: { pk: "USER#u-1" } }).resolves({});
  ddbMock.on(GetCommand, { Key: { pk: "SUB#abc123#A" } }).resolves({});
  ddbMock.on(GetCommand, { Key: { pk: "SUB#abc123#B" } }).resolves({});
  ddbMock.on(TransactWriteCommand).resolves({});

  const res = await handler(
    postEvent({
      action: "eliminate",
      pairingId: "abc123",
      role: "B",
      token: "tok-b",
      gameNumber: 1,
      index: 2,
    })
  );
  assert.equal(res.statusCode, 200);

  const tx = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input;
  assert.equal(tx.TransactItems.length, 3); // pairing + archive + ONE user

  const archive = tx.TransactItems[1].Put.Item;
  assert.deepEqual(archive.players, { A: "u-1", B: "u-1" });
  assert.equal(archive.ttl, undefined); // signed-in games are kept

  const userItem = tx.TransactItems[2].Put.Item;
  assert.equal(userItem.pk, "USER#u-1");
  assert.equal(userItem.stats.gamesPlayed, 1);
  assert.equal(userItem.stats.currentStreak, 1);
  assert.equal(userItem.recentGames[0].winnerLabel, "Ramen");
  assert.equal(userItem.ttl, undefined); // accounts never expire
  assert.equal(
    tx.TransactItems[2].Put.ConditionExpression,
    "attribute_not_exists(version)"
  );
});

test("getMe requires sign-in and gates streaks/history for free accounts", async () => {
  const anon = await handler(postEvent({ action: "getMe" }));
  assert.equal(anon.statusCode, 401);

  const recentGames = Array.from({ length: 15 }, (_, i) => ({
    pairingId: "p",
    number: i + 1,
    winnerLabel: "Pizza",
    completedAt: i,
  }));
  ddbMock.on(GetCommand, { Key: { pk: "USER#u-1" } }).resolves({
    Item: {
      pk: "USER#u-1",
      userId: "u-1",
      version: 2,
      stats: {
        gamesPlayed: 15,
        currentStreak: 4,
        bestStreak: 6,
        lastPlayedDay: "2026-07-04",
        topWinners: { Pizza: 15 },
      },
      recentGames,
      premium: { status: "none" },
    },
  });

  const res = await handler(
    postEvent({ action: "getMe" }, { authorization: "Bearer good-token" })
  );
  assert.equal(res.statusCode, 200);
  const me = JSON.parse(res.body);
  assert.equal(me.stats.gamesPlayed, 15);
  assert.equal(me.stats.currentStreak, undefined); // premium-gated at the API
  assert.equal(me.stats.topWinners, undefined);
  assert.equal(me.stats.streakLocked, true);
  assert.equal(me.recentGames.length, 10);
  assert.equal(me.historyLocked, true);
});

test("getMe returns full stats for premium accounts", async () => {
  ddbMock.on(GetCommand, { Key: { pk: "USER#u-1" } }).resolves({
    Item: {
      pk: "USER#u-1",
      userId: "u-1",
      version: 2,
      stats: {
        gamesPlayed: 3,
        currentStreak: 2,
        bestStreak: 2,
        lastPlayedDay: "2026-07-04",
        topWinners: { Pizza: 3 },
      },
      recentGames: [],
      premium: { status: "active" },
    },
  });

  const res = await handler(
    postEvent({ action: "getMe" }, { authorization: "Bearer good-token" })
  );
  const me = JSON.parse(res.body);
  assert.equal(me.stats.currentStreak, 2);
  assert.deepEqual(me.stats.topWinners, { Pizza: 3 });
  assert.equal(me.historyLocked, false);
});

test("getMe creates the user skeleton on first visit", async () => {
  ddbMock.on(GetCommand, { Key: { pk: "USER#u-1" } }).resolves({});
  ddbMock.on(PutCommand).resolves({});

  const res = await handler(
    postEvent({ action: "getMe" }, { authorization: "Bearer good-token" })
  );
  assert.equal(res.statusCode, 200);
  const put = ddbMock.commandCalls(PutCommand)[0].args[0].input;
  assert.equal(put.Item.pk, "USER#u-1");
  assert.equal(put.Item.email, "u1@example.com");
  assert.equal(put.Item.ttl, undefined);
  assert.equal(put.ConditionExpression, "attribute_not_exists(version)");
  const me = JSON.parse(res.body);
  assert.equal(me.stats.gamesPlayed, 0);
  assert.equal(me.premium.status, "none");
});

// Fake Stripe: constructEvent validates our fake signature; checkout/portal
// return canned URLs.
function fakeStripe(event) {
  return {
    webhooks: {
      constructEvent: (raw, sig) => {
        if (sig !== "valid-sig") throw new Error("bad signature");
        return event ?? JSON.parse(raw);
      },
    },
    customers: { create: async () => ({ id: "cus_1" }) },
    checkout: {
      sessions: { create: async (params) => ({ url: `https://stripe/checkout/${params.line_items[0].price}` }) },
    },
    billingPortal: { sessions: { create: async () => ({ url: "https://stripe/portal" }) } },
  };
}

const webhookEvent = (body, headers = {}) => ({
  requestContext: { http: { method: "POST", path: "/api/stripe-webhook" } },
  rawPath: "/api/stripe-webhook",
  headers,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

test("webhook rejects a bad signature", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  _setStripeForTests(fakeStripe());
  const res = await handler(webhookEvent({}, { "stripe-signature": "forged" }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, "BAD_SIGNATURE");
});

test("checkout.session.completed flips the user to premium", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  _setStripeForTests(
    fakeStripe({
      type: "checkout.session.completed",
      data: { object: { client_reference_id: "u-1", customer: "cus_1", subscription: "sub_1" } },
    })
  );
  ddbMock.on(GetCommand, { Key: { pk: "USER#u-1" } }).resolves({
    Item: { pk: "USER#u-1", userId: "u-1", version: 1, stats: {}, recentGames: [], premium: { status: "none" } },
  });
  ddbMock.on(PutCommand).resolves({});

  const res = await handler(webhookEvent({}, { "stripe-signature": "valid-sig" }));
  assert.equal(res.statusCode, 200);
  const saved = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
  assert.equal(saved.premium.status, "active");
  assert.equal(saved.premium.stripeCustomerId, "cus_1");
  assert.equal(saved.premium.stripeSubId, "sub_1");
  assert.equal(saved.version, 2);
});

test("subscription.deleted cancels premium via metadata userId", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  _setStripeForTests(
    fakeStripe({
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1", customer: "cus_1", metadata: { userId: "u-1" }, status: "canceled" } },
    })
  );
  ddbMock.on(GetCommand, { Key: { pk: "USER#u-1" } }).resolves({
    Item: { pk: "USER#u-1", userId: "u-1", version: 3, stats: {}, recentGames: [], premium: { status: "active", stripeCustomerId: "cus_1" } },
  });
  ddbMock.on(PutCommand).resolves({});

  const res = await handler(webhookEvent({}, { "stripe-signature": "valid-sig" }));
  assert.equal(res.statusCode, 200);
  const saved = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
  assert.equal(saved.premium.status, "canceled");
  assert.equal(saved.premium.stripeCustomerId, "cus_1"); // merge keeps ids
});

test("createCheckoutSession requires sign-in and a known plan", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_PRICE_MONTHLY = "price_m";
  process.env.SITE_URL = "https://example.test/";
  _setStripeForTests(fakeStripe());

  const anon = await handler(postEvent({ action: "createCheckoutSession", plan: "monthly" }));
  assert.equal(anon.statusCode, 401);

  ddbMock.on(GetCommand, { Key: { pk: "USER#u-1" } }).resolves({
    Item: { pk: "USER#u-1", userId: "u-1", version: 1, stats: {}, recentGames: [], premium: { status: "none" } },
  });
  ddbMock.on(PutCommand).resolves({});

  const bad = await handler(
    postEvent({ action: "createCheckoutSession", plan: "lifetime" }, { authorization: "Bearer good-token" })
  );
  assert.equal(bad.statusCode, 400);

  const ok = await handler(
    postEvent({ action: "createCheckoutSession", plan: "monthly" }, { authorization: "Bearer good-token" })
  );
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body).url, "https://stripe/checkout/price_m");
  // Newly-minted customer id persisted on the user item.
  const saved = ddbMock.commandCalls(PutCommand).at(-1).args[0].input.Item;
  assert.equal(saved.premium.stripeCustomerId, "cus_1");
});

test("billing actions 400 when Stripe is not configured", async () => {
  delete process.env.STRIPE_SECRET_KEY;
  const res = await handler(
    postEvent({ action: "createCheckoutSession", plan: "monthly" }, { authorization: "Bearer good-token" })
  );
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, "BILLING_DISABLED");
});

test("origin header enforced only when flag is on", async () => {
  ddbMock.on(GetCommand).resolves({ Item: pairingItem() });
  const query = { action: "getState", pairingId: "abc123", role: "A", token: "tok-a" };

  process.env.ENFORCE_ORIGIN_HEADER = "true";
  process.env.ORIGIN_VERIFY_SECRET = "s3cret";

  const blocked = await handler(getEvent(query));
  assert.equal(blocked.statusCode, 403);

  const allowed = await handler(getEvent(query, { "x-origin-verify": "s3cret" }));
  assert.equal(allowed.statusCode, 200);

  delete process.env.ENFORCE_ORIGIN_HEADER;
  const flagOff = await handler(getEvent(query));
  assert.equal(flagOff.statusCode, 200);
});
