// compaction: pure line filtering, manifest lifecycle, idempotent re-run,
// empty-object deletion — S3 fully mocked.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { compactLines, handler } from "./compaction.mjs";

const s3Mock = mockClient(S3Client);

const line = (ref, type = "cut_made") =>
  JSON.stringify({ event_id: `e-${ref}-${type}`, type, pairing_ref: ref });

test("compactLines drops tombstoned refs, keeps everything else", () => {
  const text = [line("dead"), line("alive"), line("dead"), ""].join("\n");
  const { text: out, removed } = compactLines(text, new Set(["dead"]));
  assert.equal(removed, 2);
  assert.equal(out, line("alive") + "\n");

  const all = compactLines([line("dead"), line("dead")].join("\n"), new Set(["dead"]));
  assert.equal(all.text, "");
  assert.equal(all.removed, 2);

  const none = compactLines(text, new Set(["nobody"]));
  assert.equal(none.removed, 0);
});

test("compactLines keeps unparseable lines untouched", () => {
  const junk = "not json at all";
  const { text, removed } = compactLines([junk, line("dead")].join("\n"), new Set(["dead"]));
  assert.equal(removed, 1);
  assert.equal(text, junk + "\n");
});

// --- handler end-to-end (mocked S3) ---

const body = (text) => ({ Body: { transformToString: async () => text } });

function noSuchKey() {
  const err = new Error("NoSuchKey");
  err.name = "NoSuchKey";
  return err;
}

// Lake fixture: one tombstone for "dead1"; raw zone has a mixed object, an
// all-dead object, and an untouched object.
const TOMBSTONE_KEY = "raw/type=pairing_deleted/dt=2026-07-10/1-a-0.jsonl";
const MIXED_KEY = "raw/type=cut_made/dt=2026-07-01/1-b-0.jsonl";
const ALLDEAD_KEY = "raw/type=game_finished/dt=2026-07-01/1-c-0.jsonl";
const CLEAN_KEY = "raw/type=game_created/dt=2026-07-02/1-d-0.jsonl";

function mockLake({ manifest = null } = {}) {
  s3Mock.reset();
  s3Mock
    .on(ListObjectsV2Command, { Prefix: "raw/type=pairing_deleted/" })
    .resolves({ Contents: [{ Key: TOMBSTONE_KEY }] });
  s3Mock.on(ListObjectsV2Command, { Prefix: "raw/" }).resolves({
    Contents: [
      { Key: TOMBSTONE_KEY },
      { Key: MIXED_KEY },
      { Key: ALLDEAD_KEY },
      { Key: CLEAN_KEY },
    ],
  });
  s3Mock
    .on(GetObjectCommand, { Key: TOMBSTONE_KEY })
    .resolves(
      body(
        JSON.stringify({ event_id: "t1", type: "pairing_deleted", pairing_ref: "dead1" }) + "\n"
      )
    );
  s3Mock
    .on(GetObjectCommand, { Key: MIXED_KEY })
    .resolves(body([line("dead1"), line("alive1")].join("\n") + "\n"));
  s3Mock
    .on(GetObjectCommand, { Key: ALLDEAD_KEY })
    .resolves(body(line("dead1", "game_finished") + "\n"));
  s3Mock.on(GetObjectCommand, { Key: CLEAN_KEY }).resolves(body(line("alive2") + "\n"));
  if (manifest) {
    s3Mock
      .on(GetObjectCommand, { Key: "meta/tombstones.json" })
      .resolves(body(JSON.stringify(manifest)));
  } else {
    s3Mock.on(GetObjectCommand, { Key: "meta/tombstones.json" }).rejects(noSuchKey());
  }
  s3Mock.on(PutObjectCommand).resolves({});
  s3Mock.on(DeleteObjectCommand).resolves({});
}

beforeEach(() => {
  process.env.EVENT_LAKE_BUCKET = "lake-bucket";
});

test("first run rewrites tainted objects, deletes emptied ones, applies refs", async () => {
  mockLake();
  const res = await handler();
  assert.deepEqual(res, { deletedLines: 2, appliedCount: 1 });

  const puts = s3Mock.commandCalls(PutObjectCommand).map((c) => c.args[0].input);
  // Mixed object rewritten without dead1's line.
  const rewritten = puts.find((p) => p.Key === MIXED_KEY);
  assert.equal(rewritten.Body, line("alive1") + "\n");
  // Untouched object never rewritten.
  assert.equal(puts.find((p) => p.Key === CLEAN_KEY), undefined);
  // Tombstone partition itself is never compacted (audit trail).
  assert.equal(puts.find((p) => p.Key === TOMBSTONE_KEY), undefined);
  // Fully-tombstoned object deleted, not written empty.
  const deletes = s3Mock.commandCalls(DeleteObjectCommand).map((c) => c.args[0].input.Key);
  assert.deepEqual(deletes, [ALLDEAD_KEY]);

  // Manifest lifecycle: union persisted first (crash safety), then applied.
  const manifests = puts
    .filter((p) => p.Key === "meta/tombstones.json")
    .map((p) => JSON.parse(p.Body));
  assert.deepEqual(manifests[0], { pending: ["dead1"], applied: [] });
  assert.deepEqual(manifests.at(-1), { pending: [], applied: ["dead1"] });

  const state = JSON.parse(
    puts.find((p) => p.Key === "meta/compaction-state.json").Body
  );
  assert.equal(state.lastRunDeletedLines, 2);
  assert.equal(state.appliedCount, 1);
  assert.ok(state.lastRunAt);
});

test("re-run with everything applied is a heartbeat, no rewrites", async () => {
  mockLake({ manifest: { pending: [], applied: ["dead1"] } });
  const res = await handler();
  assert.deepEqual(res, { deletedLines: 0, appliedCount: 1 });

  const puts = s3Mock.commandCalls(PutObjectCommand).map((c) => c.args[0].input);
  assert.deepEqual(puts.map((p) => p.Key), ["meta/compaction-state.json"]);
  assert.equal(s3Mock.commandCalls(DeleteObjectCommand).length, 0);
  // The idempotence hinge: applied refs never re-enter pending.
  assert.equal(JSON.parse(puts[0].Body).lastRunDeletedLines, 0);
});

test("previously-pending refs are retried after a crashed run", async () => {
  // Crash story: last run persisted pending but died before rewriting.
  mockLake({ manifest: { pending: ["dead1"], applied: [] } });
  const res = await handler();
  assert.deepEqual(res, { deletedLines: 2, appliedCount: 1 });
  const finalManifest = s3Mock
    .commandCalls(PutObjectCommand)
    .map((c) => c.args[0].input)
    .filter((p) => p.Key === "meta/tombstones.json")
    .map((p) => JSON.parse(p.Body))
    .at(-1);
  assert.deepEqual(finalManifest, { pending: [], applied: ["dead1"] });
});

test("empty lake heartbeats without touching anything", async () => {
  s3Mock.reset();
  s3Mock.on(ListObjectsV2Command).resolves({});
  s3Mock.on(GetObjectCommand).rejects(noSuchKey());
  s3Mock.on(PutObjectCommand).resolves({});

  const res = await handler();
  assert.deepEqual(res, { deletedLines: 0, appliedCount: 0 });
  const puts = s3Mock.commandCalls(PutObjectCommand).map((c) => c.args[0].input.Key);
  assert.deepEqual(puts, ["meta/compaction-state.json"]);
});

test("list pagination is followed", async () => {
  s3Mock.reset();
  s3Mock
    .on(ListObjectsV2Command, { Prefix: "raw/type=pairing_deleted/" })
    .resolvesOnce({
      Contents: [{ Key: TOMBSTONE_KEY }],
      IsTruncated: true,
      NextContinuationToken: "tok",
    })
    .resolvesOnce({ Contents: [] });
  s3Mock.on(ListObjectsV2Command, { Prefix: "raw/" }).resolves({ Contents: [] });
  s3Mock
    .on(GetObjectCommand, { Key: TOMBSTONE_KEY })
    .resolves(
      body(JSON.stringify({ event_id: "t1", type: "pairing_deleted", pairing_ref: "dead1" }))
    );
  s3Mock.on(GetObjectCommand, { Key: "meta/tombstones.json" }).rejects(noSuchKey());
  s3Mock.on(PutObjectCommand).resolves({});

  const res = await handler();
  assert.equal(res.appliedCount, 1); // ref applied even though no raw data existed
});
