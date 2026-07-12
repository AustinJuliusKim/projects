// DynamoDB Streams consumer for the S3 event lake (Data Architecture Plan,
// Stage A). Two record shapes arrive (template FilterCriteria):
//
//   EVENT# INSERT  — transactional-outbox envelopes written by handler.mjs;
//                    forwarded verbatim to the raw zone and (when ANON_SALT
//                    is configured) as a daily-rotating-hash copy to the
//                    anon zone. Their later TTL REMOVEs are filtered out.
//   PAIR# REMOVE   — pairing deletions (TTL expiry today, explicit deletes
//                    later); synthesized into pairing_deleted tombstones
//                    that drive the weekly raw-zone compaction.
//
// One JSONL object per (zone, type, dt) group per invocation:
//   <zone>/type=<type>/dt=<YYYY-MM-DD>/<epochms>-<requestId>-<n>.jsonl
//
// Delivery is at-least-once (stream retries + partial batch retry):
// consumers dedupe on event_id. Failed S3 puts are reported through
// ReportBatchItemFailures so only the affected records retry.
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { buildEvent, toAnonEnvelope, utcDayFromTs } from "./events.mjs";
import { emit } from "./metrics.mjs";

const s3 = new S3Client({});

export async function handler(event, context) {
  const bucket = process.env.EVENT_LAKE_BUCKET;
  // No salt -> the anon zone is skipped entirely (fail closed, mirroring
  // putAnonRecord): a raw-only lake beats an accidentally-linkable one.
  const salt = process.env.ANON_SALT || null;

  const entries = [];
  for (const record of event?.Records ?? []) {
    const envelope = envelopeFrom(record);
    if (envelope) entries.push({ seq: record.dynamodb?.SequenceNumber, envelope });
  }

  // Group lines by (zone, type, dt). A record rides its raw group and its
  // anon group; if either PutObject fails, the record is reported failed
  // (the retry may duplicate the other zone's line — dedupe on event_id).
  const groups = new Map();
  const add = (zone, envelope, seq) => {
    const prefix = `${zone}/type=${envelope.type}/dt=${utcDayFromTs(envelope.ts)}/`;
    if (!groups.has(prefix)) groups.set(prefix, { prefix, lines: [], seqs: [] });
    const group = groups.get(prefix);
    group.lines.push(JSON.stringify(envelope));
    group.seqs.push(seq);
  };
  for (const { seq, envelope } of entries) {
    add("raw", envelope, seq);
    if (salt) add("anon", toAnonEnvelope(envelope, salt), seq);
  }

  const failed = new Set();
  const requestId = context?.awsRequestId ?? "local";
  let n = 0;
  for (const group of groups.values()) {
    const key = `${group.prefix}${Date.now()}-${requestId}-${n++}.jsonl`;
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: group.lines.join("\n") + "\n",
          ContentType: "application/x-ndjson",
        })
      );
    } catch (err) {
      console.error("lake write failed", key, err);
      for (const seq of group.seqs) if (seq) failed.add(seq);
    }
  }

  const delivered = entries.filter((e) => !failed.has(e.seq)).length;
  if (delivered > 0) emit("EventLakeWrite", delivered);

  return {
    batchItemFailures: [...failed].map((seq) => ({ itemIdentifier: seq })),
  };
}

// Stream record -> envelope, or null to skip. Malformed outbox items are
// skipped with a log (retrying a poison item forever helps nobody);
// anything the template filter shouldn't deliver is ignored defensively.
function envelopeFrom(record) {
  const pk = record?.dynamodb?.Keys?.pk?.S ?? "";

  if (record.eventName === "INSERT" && pk.startsWith("EVENT#")) {
    if (!record.dynamodb.NewImage) return null;
    const { pk: _pk, ttl: _ttl, ...envelope } = unmarshall(record.dynamodb.NewImage);
    if (!envelope.event_id || !envelope.ts || !envelope.type) {
      console.error("malformed outbox item skipped", pk);
      return null;
    }
    return envelope;
  }

  if (record.eventName === "REMOVE" && pk.startsWith("PAIR#")) {
    // TTL deletions are performed by the DynamoDB service principal;
    // anything else is an explicit delete.
    const reason =
      record.userIdentity?.principalId === "dynamodb.amazonaws.com"
        ? "ttl"
        : "explicit";
    const atMs =
      (record.dynamodb.ApproximateCreationDateTime ?? Date.now() / 1000) * 1000;
    return buildEvent(
      "pairing_deleted",
      {
        pairingRef: pk.slice("PAIR#".length),
        actorRole: "system",
        payload: { reason },
      },
      atMs
    );
  }

  return null;
}
