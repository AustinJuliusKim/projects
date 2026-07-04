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
} from "@aws-sdk/lib-dynamodb";
import { handler } from "./handler.mjs";
import { createGame, applyElimination } from "./game.mjs";

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
