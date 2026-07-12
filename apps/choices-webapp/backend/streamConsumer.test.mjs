// streamConsumer: key layout, JSONL bodies, anon transform, no-salt skip,
// tombstone synthesis, partial-failure reporting.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { marshall } from "@aws-sdk/util-dynamodb";
import { handler } from "./streamConsumer.mjs";
import { buildEvent, eventItem, anonRef } from "./events.mjs";

const s3Mock = mockClient(S3Client);
const ctx = { awsRequestId: "req-1" };

beforeEach(() => {
  s3Mock.reset();
  s3Mock.on(PutObjectCommand).resolves({});
  process.env.EVENT_LAKE_BUCKET = "lake-bucket";
  process.env.ANON_SALT = "master-salt";
});

let seqCounter = 0;

// An EVENT# INSERT stream record wrapping a real outbox item.
function insertRecord(envelope) {
  const item = eventItem(envelope, "t").Put.Item;
  return {
    eventName: "INSERT",
    dynamodb: {
      SequenceNumber: `seq-${++seqCounter}`,
      Keys: marshall({ pk: item.pk }),
      NewImage: marshall(item),
    },
  };
}

function removeRecord(pairingId, { ttl = false, atMs = Date.UTC(2026, 6, 12, 8) } = {}) {
  return {
    eventName: "REMOVE",
    ...(ttl
      ? { userIdentity: { type: "Service", principalId: "dynamodb.amazonaws.com" } }
      : {}),
    dynamodb: {
      SequenceNumber: `seq-${++seqCounter}`,
      Keys: marshall({ pk: `PAIR#${pairingId}` }),
      ApproximateCreationDateTime: atMs / 1000,
    },
  };
}

const NOW = Date.UTC(2026, 6, 12, 3, 14, 15);

function cutEvent(pairingId, index, now = NOW) {
  return buildEvent(
    "cut_made",
    {
      pairingRef: pairingId,
      actorRole: "B",
      payload: { game_number: 1, cut_number: 1, index },
    },
    now
  );
}

const putInputs = () => s3Mock.commandCalls(PutObjectCommand).map((c) => c.args[0].input);

test("groups events by zone/type/dt and writes JSONL with the envelope shape", async () => {
  const a = cutEvent("pair-a", 0);
  const b = cutEvent("pair-b", 1);
  const other = buildEvent(
    "game_created",
    {
      pairingRef: "pair-a",
      actorRole: "A",
      payload: { game_number: 1, choice_count: 4, source: "manual" },
    },
    NOW
  );

  const res = await handler(
    { Records: [insertRecord(a), insertRecord(b), insertRecord(other)] },
    ctx
  );
  assert.deepEqual(res, { batchItemFailures: [] });

  const puts = putInputs();
  // 2 types x 2 zones = 4 objects; same-type events share one object.
  assert.equal(puts.length, 4);
  assert.ok(puts.every((p) => p.Bucket === "lake-bucket"));
  const keys = puts.map((p) => p.Key).sort();
  assert.match(keys[0], /^anon\/type=cut_made\/dt=2026-07-12\/\d+-req-1-\d+\.jsonl$/);
  assert.match(keys[1], /^anon\/type=game_created\/dt=2026-07-12\//);
  assert.match(keys[2], /^raw\/type=cut_made\/dt=2026-07-12\//);
  assert.match(keys[3], /^raw\/type=game_created\/dt=2026-07-12\//);

  const rawCut = puts.find((p) => p.Key.startsWith("raw/type=cut_made/"));
  const lines = rawCut.Body.trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  // Envelope forwarded verbatim: no pk/ttl leakage, fields intact.
  assert.deepEqual(Object.keys(lines[0]).sort(), [
    "actor_role",
    "event_id",
    "pairing_ref",
    "payload",
    "schema_v",
    "ts",
    "type",
  ]);
  assert.deepEqual(lines[0], a);
  assert.deepEqual(lines[1], b);
});

test("anon zone carries the daily-rotating hash, never the raw pairing id", async () => {
  const ev = cutEvent("pair-secret", 2);
  await handler({ Records: [insertRecord(ev)] }, ctx);

  const anon = putInputs().find((p) => p.Key.startsWith("anon/"));
  const line = JSON.parse(anon.Body.trim());
  assert.equal(line.pairing_ref, anonRef("master-salt", "pair-secret", ev.ts));
  assert.equal(line.event_id, ev.event_id); // dedupe key shared across zones
  assert.ok(!anon.Body.includes("pair-secret"));
});

test("without ANON_SALT the anon zone is skipped entirely", async () => {
  delete process.env.ANON_SALT;
  await handler({ Records: [insertRecord(cutEvent("pair-a", 0))] }, ctx);

  const puts = putInputs();
  assert.equal(puts.length, 1);
  assert.ok(puts[0].Key.startsWith("raw/"));
});

test("PAIR# REMOVE synthesizes pairing_deleted with ttl vs explicit reasons", async () => {
  await handler(
    {
      Records: [
        removeRecord("pair-ttl", { ttl: true }),
        removeRecord("pair-exp", { ttl: false }),
      ],
    },
    ctx
  );

  const raw = putInputs().find((p) => p.Key.startsWith("raw/type=pairing_deleted/"));
  assert.match(raw.Key, /dt=2026-07-12\//);
  const lines = raw.Body.trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => [l.pairing_ref, l.payload.reason, l.actor_role]),
    [
      ["pair-ttl", "ttl", "system"],
      ["pair-exp", "explicit", "system"],
    ]
  );
  assert.equal(lines[0].type, "pairing_deleted");
  assert.equal(lines[0].ts, "2026-07-12T08:00:00.000Z");
  // Tombstones also land in the anon zone (hashed ref) per catalog "copy".
  const anon = putInputs().find((p) => p.Key.startsWith("anon/type=pairing_deleted/"));
  assert.ok(!anon.Body.includes("pair-ttl"));
});

test("a failed put reports only its records as batch item failures", async () => {
  const cut = cutEvent("pair-a", 0);
  const created = buildEvent(
    "game_created",
    {
      pairingRef: "pair-a",
      actorRole: "A",
      payload: { game_number: 1, choice_count: 4, source: "manual" },
    },
    NOW
  );
  const cutRecord = insertRecord(cut);
  const createdRecord = insertRecord(created);

  s3Mock.on(PutObjectCommand).callsFake((input) => {
    if (input.Key.startsWith("raw/type=cut_made/")) {
      throw new Error("s3 down for this prefix");
    }
    return {};
  });

  const res = await handler({ Records: [cutRecord, createdRecord] }, ctx);
  assert.deepEqual(res.batchItemFailures, [
    { itemIdentifier: cutRecord.dynamodb.SequenceNumber },
  ]);
});

test("malformed outbox items and unexpected records are skipped, not retried", async () => {
  const junk = {
    eventName: "INSERT",
    dynamodb: {
      SequenceNumber: "seq-junk",
      Keys: marshall({ pk: "EVENT#broken" }),
      NewImage: marshall({ pk: "EVENT#broken", ttl: 1 }), // no type/ts/event_id
    },
  };
  const unexpected = {
    eventName: "MODIFY",
    dynamodb: { SequenceNumber: "seq-mod", Keys: marshall({ pk: "PAIR#x" }) },
  };
  const res = await handler({ Records: [junk, unexpected] }, ctx);
  assert.deepEqual(res, { batchItemFailures: [] });
  assert.equal(putInputs().length, 0);
});
