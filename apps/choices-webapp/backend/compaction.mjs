// Weekly tombstone-driven compaction of the event lake's RAW zone (Data
// Architecture Plan §"Deletion story"): pairing_deleted events accumulate
// as tombstones; this job rewrites raw-zone objects minus the tombstoned
// pairing_refs. The anon zone needs no deletion path — its refs rotate
// daily and are one-way, so there is nothing to unlink.
//
// State (both under meta/, never inside a queryable partition):
//   meta/tombstones.json       { pending: [refs], applied: [refs] }
//   meta/compaction-state.json { lastRunAt, lastRunDeletedLines, appliedCount }
//
// Tombstone events themselves are retained (audit trail — a pairing_ref is
// a random 12-hex id, not PII). A full-lake pass is fine at current
// volume; bounded work is a Stage B (Parquet compaction) concern. The
// bucket's versioning + 30-day noncurrent expiry is the safety net for a
// compaction bug.
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({});

const TOMBSTONES_KEY = "meta/tombstones.json";
const STATE_KEY = "meta/compaction-state.json";
const TOMBSTONE_PREFIX = "raw/type=pairing_deleted/";

// Pure line filter: drop JSONL lines whose pairing_ref is tombstoned.
// Unparseable lines are kept — compaction must never destroy data it
// doesn't understand. Returns { text, removed }.
export function compactLines(jsonlText, refSet) {
  const lines = String(jsonlText)
    .split("\n")
    .filter((l) => l.length > 0);
  const kept = lines.filter((line) => {
    try {
      return !refSet.has(JSON.parse(line).pairing_ref);
    } catch {
      return true;
    }
  });
  return {
    text: kept.length ? kept.join("\n") + "\n" : "",
    removed: lines.length - kept.length,
  };
}

export async function handler() {
  const bucket = process.env.EVENT_LAKE_BUCKET;
  const now = new Date().toISOString();

  // 1. Collect tombstoned refs (the pairing_deleted partition is tiny) and
  // union them into the manifest; refs already applied stay applied.
  const refs = new Set();
  for (const key of await listAll(bucket, TOMBSTONE_PREFIX)) {
    for (const line of (await getText(bucket, key)).split("\n")) {
      if (!line) continue;
      try {
        const ref = JSON.parse(line).pairing_ref;
        if (ref) refs.add(ref);
      } catch {
        // skip junk lines; they carry no ref to act on
      }
    }
  }
  const manifest = (await getJson(bucket, TOMBSTONES_KEY)) ?? { pending: [], applied: [] };
  const applied = new Set(manifest.applied ?? []);
  const pending = new Set(manifest.pending ?? []);
  for (const ref of refs) if (!applied.has(ref)) pending.add(ref);

  // 2. Nothing to do -> heartbeat only.
  if (pending.size === 0) {
    await putJson(bucket, STATE_KEY, {
      lastRunAt: now,
      lastRunDeletedLines: 0,
      appliedCount: applied.size,
    });
    return { deletedLines: 0, appliedCount: applied.size };
  }

  // Persist the union first: a crash mid-rewrite keeps the refs pending,
  // and the whole pass is idempotent (re-filtering already-filtered
  // objects removes zero lines).
  await putJson(bucket, TOMBSTONES_KEY, {
    pending: [...pending],
    applied: [...applied],
  });

  // 3. Rewrite every raw object that carries a pending ref.
  let deletedLines = 0;
  const keys = (await listAll(bucket, "raw/")).filter(
    (k) => !k.startsWith(TOMBSTONE_PREFIX)
  );
  for (const key of keys) {
    const { text, removed } = compactLines(await getText(bucket, key), pending);
    if (removed === 0) continue;
    deletedLines += removed;
    if (text === "") {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } else {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: text,
          ContentType: "application/x-ndjson",
        })
      );
    }
  }

  // 4. pending -> applied; record the run.
  const appliedAll = [...applied, ...pending];
  await putJson(bucket, TOMBSTONES_KEY, { pending: [], applied: appliedAll });
  await putJson(bucket, STATE_KEY, {
    lastRunAt: now,
    lastRunDeletedLines: deletedLines,
    appliedCount: appliedAll.length,
  });
  return { deletedLines, appliedCount: appliedAll.length };
}

// --- S3 helpers ---

async function listAll(bucket, prefix) {
  const keys = [];
  let ContinuationToken;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken })
    );
    for (const obj of res.Contents ?? []) keys.push(obj.Key);
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

async function getText(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return res.Body.transformToString();
}

async function getJson(bucket, key) {
  try {
    return JSON.parse(await getText(bucket, key));
  } catch (err) {
    if (err?.name === "NoSuchKey" || err?.name === "NotFound") return null;
    if (err instanceof SyntaxError) {
      // A corrupt manifest must not brick deletion forever: start fresh
      // (worst case some refs re-apply — idempotent by construction).
      console.error("corrupt manifest, starting fresh", key, err);
      return null;
    }
    throw err;
  }
}

async function putJson(bucket, key, value) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: "application/json",
    })
  );
}
