// Feature flags (Growth Plan §10c, locked 2026-07-23): DynamoDB-backed,
// single FLAGS#global item on the existing table, 60s in-Lambda cache.
// The item stores OVERRIDES only — anything absent falls back to the
// code-owned defaults below, so the system works before the item exists
// and keeps working through any store error. isEnabled never throws.
import { GetCommand } from "@aws-sdk/lib-dynamodb";

export const FLAGS_PK = "FLAGS#global";
export const CACHE_TTL_MS = 60_000;

// The registry: every flag the system knows. `public: true` flags (and only
// those) are exposed to clients via getFlags. Lifecycle prefixes per §10c:
// release_ (delete after full rollout) / ops_ (kill switches) / exp_.
export const FLAG_DEFS = Object.freeze({
  ops_kill_places: {
    default: false,
    description: "Kill switch: Google Places typeahead proxy (sheds L3 cost under load).",
    type: "ops",
    public: false,
  },
  ops_kill_fill4: {
    default: false,
    description: "Kill switch: Fill-my-4 Bedrock calls.",
    type: "ops",
    public: false,
  },
  release_reveal_card: {
    default: true,
    description: "Shareable reveal card (shipped 2026-07-07; flag for emergency rollback).",
    type: "release",
    public: true,
  },
  release_realtime_subscribe: {
    default: false,
    description: "§10a P2: client subscribes to AppSync Events (dark until built).",
    type: "release",
    public: true,
  },
  release_polling_demoted: {
    default: false,
    description: "§10a P3: demote polling to 30-60s keepalive once realtime is proven.",
    type: "release",
    public: true,
  },
});

// Injected I/O (house style: node:test has no ergonomic ESM mocking).
let ddb = null;
let tableName = null;
export function configureFlagsStore(client, table) {
  ddb = client;
  tableName = table ?? process.env.TABLE_NAME;
}
export function _resetForTests() {
  cache = null;
}

let cache = null; // { overrides, version, fetchedAt }

// Read the FLAGS#global item through the 60s cache. Any failure yields the
// empty override set (=> code defaults) without poisoning future reads.
async function readOverrides(now) {
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache;
  try {
    const res = await ddb.send(
      new GetCommand({ TableName: tableName, Key: { pk: FLAGS_PK } })
    );
    cache = {
      overrides: res.Item?.flags ?? {},
      version: res.Item?.version ?? null,
      fetchedAt: now,
    };
  } catch (err) {
    console.error("flags read failed — serving defaults", err);
    cache = { overrides: {}, version: null, fetchedAt: now };
  }
  return cache;
}

// Effective value for one flag. Unknown flags are false. Never throws.
export async function isEnabled(name, now = Date.now()) {
  const def = FLAG_DEFS[name];
  if (!def) return false;
  const { overrides } = await readOverrides(now);
  return overrides[name]?.enabled ?? def.default;
}

// Client-visible subset: {name: enabled} for public flags only. Anything
// non-public must never appear here (§10c locked constraint).
export async function publicFlags(now = Date.now()) {
  const { overrides } = await readOverrides(now);
  const out = {};
  for (const [name, def] of Object.entries(FLAG_DEFS)) {
    if (def.public) out[name] = overrides[name]?.enabled ?? def.default;
  }
  return out;
}

// Pure merge of an override map + defs into the admin view shape.
export function mergeView(overrides, version) {
  const flags = {};
  for (const [name, def] of Object.entries(FLAG_DEFS)) {
    const o = overrides[name];
    flags[name] = {
      enabled: o?.enabled ?? def.default,
      default: def.default,
      description: def.description,
      type: def.type,
      public: def.public,
      updatedAt: o?.updatedAt ?? null,
      updatedBy: o?.updatedBy ?? null,
    };
  }
  return { flags, version };
}

// Full merged view for the admin surface, plus the item version the admin
// client must echo back on adminSetFlag (optimistic concurrency).
export async function listFlags(now = Date.now()) {
  const { overrides, version } = await readOverrides(now);
  return mergeView(overrides, version);
}

// After a successful write the old cache is stale by definition.
export function bustFlagsCache() {
  cache = null;
}
