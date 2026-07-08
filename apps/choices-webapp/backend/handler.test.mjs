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
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { handler } from "./handler.mjs";
import { createGame, applyElimination } from "./game.mjs";
import { _setVerifierForTests } from "./auth.mjs";
import { _setStripeForTests } from "./billing.mjs";
import { _setPlacesFetchForTests } from "./places.mjs";
import { _setBedrockForTests } from "./suggestai.mjs";

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
const s3Mock = mockClient(S3Client);

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
  s3Mock.reset();
  delete process.env.ENFORCE_ORIGIN_HEADER;
  delete process.env.ORIGIN_VERIFY_SECRET;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.SUGGEST_BUCKET;
  delete process.env.ANON_SALT;
  delete process.env.PLACES_API_KEY;
  delete process.env.BEDROCK_MODEL_ID;
  _setPlacesFetchForTests(null);
  _setBedrockForTests(null);
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
  ddbMock.on(GetCommand).resolves({});
  ddbMock
    .on(GetCommand, { Key: { pk: "PAIR#abc123" } })
    .resolves({ Item: nearlyWonPairing() });
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
  assert.equal(tx.TransactItems.length, 3);

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

  // Pair-memory fold (suggestion engine Phase 0) rides the same transaction.
  const histPut = tx.TransactItems[2].Put;
  const hist = histPut.Item;
  assert.equal(hist.pk, "HIST#abc123");
  assert.equal(hist.entries.ramen.winCount, 1);
  assert.equal(hist.entries.ramen.entryCount, 1);
  assert.equal(hist.entries.pizza.winCount, 0);
  assert.equal(Object.keys(hist.entries).length, 4);
  assert.ok(hist.ttl > 0);
  assert.equal(histPut.ConditionExpression, "attribute_not_exists(version)");

  // Anonymized S3 feed is config-gated and off by default.
  assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0);
});

test("completing eliminate writes the anonymized S3 record when configured", async () => {
  process.env.SUGGEST_BUCKET = "suggest-bucket";
  process.env.ANON_SALT = "test-salt";
  ddbMock.on(GetCommand).resolves({});
  ddbMock
    .on(GetCommand, { Key: { pk: "PAIR#abc123" } })
    .resolves({ Item: nearlyWonPairing() });
  ddbMock.on(TransactWriteCommand).resolves({});
  s3Mock.on(PutObjectCommand).resolves({});

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

  const put = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
  assert.equal(put.Bucket, "suggest-bucket");
  assert.match(put.Key, /^entries\/dt=\d{4}-\d{2}-\d{2}\//);
  const record = JSON.parse(put.Body);
  assert.deepEqual(record.choices, ["pizza", "tacos", "sushi", "ramen"]);
  assert.equal(record.winner, "ramen");
  assert.equal(record.pairHash.length, 16);
  assert.equal(record.pairingId, undefined); // never linkable back to a pair
  assert.ok(!put.Body.includes("abc123"));
});

test("anonymized record failure never breaks the winning move", async () => {
  process.env.SUGGEST_BUCKET = "suggest-bucket";
  process.env.ANON_SALT = "test-salt";
  ddbMock.on(GetCommand).resolves({});
  ddbMock
    .on(GetCommand, { Key: { pk: "PAIR#abc123" } })
    .resolves({ Item: nearlyWonPairing() });
  ddbMock.on(TransactWriteCommand).resolves({});
  s3Mock.on(PutObjectCommand).rejects(new Error("bucket unavailable"));

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
  assert.equal(JSON.parse(res.body).state.game.status, "complete");
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
  // No history work on the hot path: HIST# is only touched on completion.
  const gets = ddbMock.commandCalls(GetCommand).map((c) => c.args[0].input.Key.pk);
  assert.ok(!gets.some((pk) => pk.startsWith("HIST#")));
  assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 0);
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
  ddbMock.on(GetCommand, { Key: { pk: "HIST#abc123" } }).resolves({});
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
  assert.equal(tx.TransactItems.length, 4); // pairing + archive + ONE user + hist

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

test("getPairHistory requires a valid seat token", async () => {
  ddbMock
    .on(GetCommand, { Key: { pk: "PAIR#abc123" } })
    .resolves({ Item: pairingItem() });

  const res = await handler(
    postEvent({ action: "getPairHistory", pairingId: "abc123", role: "A", token: "wrong" })
  );
  assert.equal(res.statusCode, 403);
});

test("getPairHistory returns entries, empty before any game finishes, and never leaks credentials", async () => {
  ddbMock
    .on(GetCommand, { Key: { pk: "PAIR#abc123" } })
    .resolves({ Item: pairingItem() });
  ddbMock.on(GetCommand, { Key: { pk: "HIST#abc123" } }).resolves({});

  const empty = await handler(
    postEvent({ action: "getPairHistory", pairingId: "abc123", role: "A", token: "tok-a" })
  );
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(JSON.parse(empty.body), { entries: [] });

  const entry = { label: "Ramen", entryCount: 2, winCount: 1, lastAt: 1000 };
  ddbMock
    .on(GetCommand, { Key: { pk: "HIST#abc123" } })
    .resolves({ Item: { pk: "HIST#abc123", entries: { ramen: entry } } });

  const res = await handler(
    postEvent({ action: "getPairHistory", pairingId: "abc123", role: "A", token: "tok-a" })
  );
  assert.deepEqual(JSON.parse(res.body).entries, [entry]);
  assert.ok(!res.body.includes("PLUM-42"));
  assert.ok(!res.body.includes("tok-a"));
  assert.ok(!res.body.includes("tok-b"));
});

test("placesSuggest without a key reports disabled and never calls upstream", async () => {
  let called = 0;
  _setPlacesFetchForTests(async () => {
    called++;
    return { ok: true, json: async () => ({}) };
  });

  const res = await handler(
    postEvent({ action: "placesSuggest", input: "piz", sessionToken: "s-1" })
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { suggestions: [], enabled: false });
  assert.equal(called, 0);
});

test("placesSuggest proxies with the session token and clamps results", async () => {
  process.env.PLACES_API_KEY = "places-key";
  let seen;
  _setPlacesFetchForTests(async (url, opts) => {
    seen = { url, opts };
    return {
      ok: true,
      json: async () => ({
        suggestions: Array.from({ length: 8 }, (_, i) => ({
          placePrediction: {
            placeId: `place-${i}`,
            structuredFormat: { mainText: { text: `Pizza Spot ${i}` } },
          },
        })),
      }),
    };
  });

  const res = await handler(
    postEvent({ action: "placesSuggest", input: "pizza", sessionToken: "s-1" })
  );
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.enabled, true);
  assert.equal(data.suggestions.length, 5); // clamped
  assert.deepEqual(data.suggestions[0], { text: "Pizza Spot 0", placeId: "place-0" });

  const body = JSON.parse(seen.opts.body);
  assert.equal(body.input, "pizza");
  assert.equal(body.sessionToken, "s-1");
  assert.deepEqual(body.includedPrimaryTypes, ["restaurant"]);
  assert.ok(body.locationBias.rectangle); // no coords -> neutral world rect
  assert.equal(seen.opts.headers["X-Goog-Api-Key"], "places-key");
});

// Bias comes from body coords (browser geolocation via the 📍 pin) — a
// world rectangle otherwise, because a bare omission would fall back to
// Google IP-biasing the Lambda's region.
const WORLD_RECT = {
  rectangle: {
    low: { latitude: -90, longitude: -180 },
    high: { latitude: 90, longitude: 180 },
  },
};

test("placesSuggest biases by body coords and never echoes them", async () => {
  process.env.PLACES_API_KEY = "places-key";
  let seen;
  _setPlacesFetchForTests(async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ suggestions: [] }) };
  });

  const res = await handler(
    postEvent({
      action: "placesSuggest",
      input: "pizza",
      sessionToken: "s-1",
      geo: { latitude: 47.61, longitude: -122.33 },
    })
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(seen.opts.body);
  assert.deepEqual(body.locationBias, {
    circle: { center: { latitude: 47.61, longitude: -122.33 }, radius: 30000 },
  });
  // Coordinates are used upstream only — never echoed to the client.
  assert.ok(!res.body.includes("47.61"));
});

test("placesSuggest without coords sends the neutral world rectangle", async () => {
  process.env.PLACES_API_KEY = "places-key";
  const bodies = [];
  _setPlacesFetchForTests(async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ suggestions: [] }) };
  });

  await handler(postEvent({ action: "placesSuggest", input: "pizza" }));
  // Old clients may still send the retired nearMe flag — same neutral path.
  await handler(postEvent({ action: "placesSuggest", input: "pizza", nearMe: false }));

  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].locationBias, WORLD_RECT);
  assert.deepEqual(bodies[1].locationBias, WORLD_RECT);
});

test("placesSuggest treats junk or out-of-range body coords as absent", async () => {
  process.env.PLACES_API_KEY = "places-key";
  const bodies = [];
  _setPlacesFetchForTests(async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ suggestions: [] }) };
  });

  for (const geo of [
    { latitude: "abc", longitude: -122 },
    { latitude: 999, longitude: -122 },
    { longitude: -122 }, // latitude missing entirely
    "not-an-object",
  ]) {
    const res = await handler(postEvent({ action: "placesSuggest", input: "pizza", geo }));
    assert.equal(res.statusCode, 200);
  }
  assert.equal(bodies.length, 4);
  assert.ok(bodies.every((b) => JSON.stringify(b.locationBias) === JSON.stringify(WORLD_RECT)));
});

test("placesSuggest validates input length without calling upstream", async () => {
  process.env.PLACES_API_KEY = "places-key";
  let called = 0;
  _setPlacesFetchForTests(async () => {
    called++;
    return { ok: true, json: async () => ({}) };
  });

  const short = await handler(postEvent({ action: "placesSuggest", input: "p" }));
  assert.deepEqual(JSON.parse(short.body), { suggestions: [], enabled: true });
  const long = await handler(
    postEvent({ action: "placesSuggest", input: "x".repeat(61) })
  );
  assert.deepEqual(JSON.parse(long.body), { suggestions: [], enabled: true });
  assert.equal(called, 0);
});

test("placesSuggest degrades to empty results when upstream fails", async () => {
  process.env.PLACES_API_KEY = "places-key";
  _setPlacesFetchForTests(async () => ({ ok: false, status: 429, json: async () => ({}) }));

  const res = await handler(postEvent({ action: "placesSuggest", input: "pizza" }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { suggestions: [], enabled: true });
});

test("placeDetails terminates the session with the Essentials field mask", async () => {
  process.env.PLACES_API_KEY = "places-key";
  let seen;
  _setPlacesFetchForTests(async (url, opts) => {
    seen = { url, opts };
    return {
      ok: true,
      json: async () => ({
        id: "place-1",
        displayName: { text: "Pizza Spot" },
        formattedAddress: "1 Main St",
      }),
    };
  });

  const res = await handler(
    postEvent({ action: "placeDetails", placeId: "place-1", sessionToken: "s-1" })
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body).place, {
    id: "place-1",
    name: "Pizza Spot",
    address: "1 Main St",
  });
  assert.ok(seen.url.includes("/places/place-1"));
  assert.ok(seen.url.includes("sessionToken=s-1"));
  assert.equal(
    seen.opts.headers["X-Goog-FieldMask"],
    "id,displayName,formattedAddress"
  );

  const missing = await handler(postEvent({ action: "placeDetails" }));
  assert.equal(missing.statusCode, 400);
});

// Fake Bedrock: counts invocations, returns a canned 4-choice reply.
function fakeBedrock(reply = '["Pizza", "Tacos", "Sushi", "Ramen"]') {
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      calls.push(cmd);
      return { output: { message: { content: [{ text: reply }] } } };
    },
  };
}

const CURRENT_MONTH = new Date().toISOString().slice(0, 7);

test("fillMyFour 400s when Bedrock is not configured", async () => {
  const res = await handler(postEvent({ action: "fillMyFour" }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).code, "AI_DISABLED");
});

test("fillMyFour on the create screen requires sign-in", async () => {
  process.env.BEDROCK_MODEL_ID = "model-x";
  _setBedrockForTests(fakeBedrock());
  const res = await handler(postEvent({ action: "fillMyFour", occasion: "Date night" }));
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.body).code, "SIGN_IN_REQUIRED");
});

test("fillMyFour on the create screen counts uses on the account", async () => {
  process.env.BEDROCK_MODEL_ID = "model-x";
  const bedrock = fakeBedrock();
  _setBedrockForTests(bedrock);
  ddbMock.on(GetCommand, { Key: { pk: "USER#u-1" } }).resolves({
    Item: {
      pk: "USER#u-1", userId: "u-1", version: 1,
      stats: {}, recentGames: [], premium: { status: "none" },
    },
  });
  ddbMock.on(PutCommand).resolves({});

  const res = await handler(
    postEvent(
      { action: "fillMyFour", occasion: "Date night" },
      { authorization: "Bearer good-token" }
    )
  );
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.deepEqual(data.choices, ["Pizza", "Tacos", "Sushi", "Ramen"]);
  assert.equal(data.usesLeft, 2);
  assert.equal(bedrock.calls.length, 1);

  const saved = ddbMock.commandCalls(PutCommand).at(-1).args[0].input.Item;
  assert.deepEqual(saved.aiUses, { month: CURRENT_MONTH, uses: 1 });
});

test("fillMyFour enforces the monthly cap and resets on rollover", async () => {
  process.env.BEDROCK_MODEL_ID = "model-x";
  const bedrock = fakeBedrock();
  _setBedrockForTests(bedrock);
  const userItem = (aiUses) => ({
    pk: "USER#u-1", userId: "u-1", version: 1,
    stats: {}, recentGames: [], premium: { status: "none" }, aiUses,
  });
  ddbMock.on(PutCommand).resolves({});

  // At the cap this month -> blocked before any Bedrock call.
  ddbMock
    .on(GetCommand, { Key: { pk: "USER#u-1" } })
    .resolves({ Item: userItem({ month: CURRENT_MONTH, uses: 3 }) });
  const blocked = await handler(
    postEvent({ action: "fillMyFour" }, { authorization: "Bearer good-token" })
  );
  assert.equal(blocked.statusCode, 409);
  assert.equal(JSON.parse(blocked.body).code, "AI_LIMIT");
  assert.equal(bedrock.calls.length, 0);

  // Same uses recorded against an old month -> fresh allowance.
  ddbMock
    .on(GetCommand, { Key: { pk: "USER#u-1" } })
    .resolves({ Item: userItem({ month: "2020-01", uses: 3 }) });
  const rolled = await handler(
    postEvent({ action: "fillMyFour" }, { authorization: "Bearer good-token" })
  );
  assert.equal(rolled.statusCode, 200);
  assert.equal(JSON.parse(rolled.body).usesLeft, 2);
});

test("fillMyFour is unlimited for premium accounts", async () => {
  process.env.BEDROCK_MODEL_ID = "model-x";
  _setBedrockForTests(fakeBedrock());
  ddbMock.on(GetCommand, { Key: { pk: "USER#u-1" } }).resolves({
    Item: {
      pk: "USER#u-1", userId: "u-1", version: 1, stats: {}, recentGames: [],
      premium: { status: "active" },
      aiUses: { month: CURRENT_MONTH, uses: 99 },
    },
  });
  ddbMock.on(PutCommand).resolves({});

  const res = await handler(
    postEvent({ action: "fillMyFour" }, { authorization: "Bearer good-token" })
  );
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).usesLeft, null);
});

test("fillMyFour on a pairing counts on the pairing and feeds pair history to the prompt", async () => {
  process.env.BEDROCK_MODEL_ID = "model-x";
  const bedrock = fakeBedrock();
  _setBedrockForTests(bedrock);
  ddbMock.on(GetCommand).resolves({});
  ddbMock
    .on(GetCommand, { Key: { pk: "PAIR#abc123" } })
    .resolves({ Item: pairingItem() });
  ddbMock.on(GetCommand, { Key: { pk: "HIST#abc123" } }).resolves({
    Item: {
      pk: "HIST#abc123",
      entries: { ramen: { label: "Ramen", entryCount: 2, winCount: 1, lastAt: 1 } },
    },
  });
  ddbMock.on(PutCommand).resolves({});

  const res = await handler(
    postEvent({
      action: "fillMyFour",
      pairingId: "abc123",
      role: "A",
      token: "tok-a",
      occasion: "Date night",
      actionId: "aid-fill",
    })
  );
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.usesLeft, 2);

  const prompt = bedrock.calls[0].input.messages[0].content[0].text;
  assert.ok(prompt.includes("Ramen (won 1x)"));
  assert.ok(prompt.includes("Occasion: Date night"));

  const saved = ddbMock.commandCalls(PutCommand).at(-1).args[0].input;
  assert.equal(saved.Item.pk, "PAIR#abc123");
  assert.equal(saved.Item.ai.uses, 1);
  assert.equal(saved.Item.ai.month, CURRENT_MONTH);
  assert.deepEqual(saved.Item.ai.lastResult, ["Pizza", "Tacos", "Sushi", "Ramen"]);
  assert.equal(saved.ConditionExpression, "version = :v");
});

test("fillMyFour on a pairing blocks at the cap without calling Bedrock", async () => {
  process.env.BEDROCK_MODEL_ID = "model-x";
  const bedrock = fakeBedrock();
  _setBedrockForTests(bedrock);
  ddbMock.on(GetCommand).resolves({});
  ddbMock.on(GetCommand, { Key: { pk: "PAIR#abc123" } }).resolves({
    Item: pairingItem({ ai: { month: CURRENT_MONTH, uses: 3 } }),
  });

  const res = await handler(
    postEvent({ action: "fillMyFour", pairingId: "abc123", role: "A", token: "tok-a" })
  );
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).code, "AI_LIMIT");
  assert.equal(bedrock.calls.length, 0);
});

test("fillMyFour replays a duplicate actionId without a second Bedrock call", async () => {
  process.env.BEDROCK_MODEL_ID = "model-x";
  const bedrock = fakeBedrock();
  _setBedrockForTests(bedrock);
  ddbMock.on(GetCommand, { Key: { pk: "PAIR#abc123" } }).resolves({
    Item: pairingItem({
      lastActionId: "aid-fill",
      ai: {
        month: CURRENT_MONTH,
        uses: 1,
        usesLeft: 2,
        lastResult: ["Pizza", "Tacos", "Sushi", "Ramen"],
      },
    }),
  });

  const res = await handler(
    postEvent({
      action: "fillMyFour",
      pairingId: "abc123",
      role: "A",
      token: "tok-a",
      actionId: "aid-fill",
    })
  );
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.deepEqual(data.choices, ["Pizza", "Tacos", "Sushi", "Ramen"]);
  assert.equal(data.usesLeft, 2);
  assert.equal(bedrock.calls.length, 0);
  assert.equal(ddbMock.commandCalls(PutCommand).length, 0);
});

test("fillMyFour surfaces an unparseable model reply as AI_FAILED", async () => {
  process.env.BEDROCK_MODEL_ID = "model-x";
  _setBedrockForTests(fakeBedrock("I would suggest pizza and tacos!"));
  ddbMock.on(GetCommand, { Key: { pk: "USER#u-1" } }).resolves({
    Item: {
      pk: "USER#u-1", userId: "u-1", version: 1,
      stats: {}, recentGames: [], premium: { status: "none" },
    },
  });

  const res = await handler(
    postEvent({ action: "fillMyFour" }, { authorization: "Bearer good-token" })
  );
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).code, "AI_FAILED");
});

const jEvent = (path) => ({
  requestContext: { http: { method: "GET", path } },
  rawPath: path,
  headers: {},
});

test("GET /j/{code} renders an OG page with the choices and a join redirect", async () => {
  process.env.SITE_URL = "https://example.test/";
  ddbMock
    .on(GetCommand, { Key: { pk: "CODE#PLUM-42" } })
    .resolves({ Item: { pk: "CODE#PLUM-42", pairingId: "abc123" } });
  ddbMock
    .on(GetCommand, { Key: { pk: "PAIR#abc123" } })
    .resolves({ Item: pairingItem() });

  const res = await handler(jEvent("/j/plum-42"));
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.ok(res.body.includes("Pizza vs Tacos vs Sushi vs Ramen"));
  assert.ok(res.body.includes("/#/join?code=PLUM-42"));
  assert.ok(res.body.includes("https://example.test/og-card.png"));
  // The code IS the invite; tokens must never appear.
  assert.ok(!res.body.includes("tok-a"));
  assert.ok(!res.body.includes("tok-b"));
  delete process.env.SITE_URL;
});

test("GET /j/{code} downgrades a profane label to the generic description", async () => {
  ddbMock
    .on(GetCommand, { Key: { pk: "CODE#PLUM-42" } })
    .resolves({ Item: { pk: "CODE#PLUM-42", pairingId: "abc123" } });
  const item = pairingItem();
  item.game = createGame(["Pizza", "fuck this place", "Sushi", "Ramen"]);
  ddbMock.on(GetCommand, { Key: { pk: "PAIR#abc123" } }).resolves({ Item: item });

  const res = await handler(jEvent("/j/PLUM-42"));
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes("4 choices. 3 cuts. 1 winner."));
  assert.ok(!res.body.includes("fuck"));
  // The join redirect still carries the code — moderation never blocks play.
  assert.ok(res.body.includes("/#/join?code=PLUM-42"));
});

test("GET /j/ with an unknown or missing code falls back to the generic page", async () => {
  ddbMock.on(GetCommand).resolves({});

  const unknown = await handler(jEvent("/j/NOPE-99"));
  assert.equal(unknown.statusCode, 200);
  assert.ok(unknown.body.includes("4 choices. 3 cuts. 1 winner."));
  assert.ok(unknown.body.includes("/#/join"));
  assert.ok(!unknown.body.includes("join?code="));

  const missing = await handler(jEvent("/j/"));
  assert.equal(missing.statusCode, 200);
});

test("GET /j/ escapes HTML in choice labels", async () => {
  ddbMock
    .on(GetCommand, { Key: { pk: "CODE#PLUM-42" } })
    .resolves({ Item: { pk: "CODE#PLUM-42", pairingId: "abc123" } });
  const item = pairingItem();
  item.game = createGame(['a"><script>x</script>', "b", "c", "d"]);
  ddbMock.on(GetCommand, { Key: { pk: "PAIR#abc123" } }).resolves({ Item: item });

  const res = await handler(jEvent("/j/PLUM-42"));
  assert.ok(!res.body.includes("<script>x</script>"));
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
