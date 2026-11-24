# @baby/core

The frozen data contract shared by baby-tracking apps: a baby profile, a
timeline event, an export envelope, and a merge function.

MIT-licensed on purpose. The point of this package is to be adoptable by a
*separate* repository — see "Convergence" below — and a restrictive license
would defeat that.

## Why this exists

`apps/baby-solids` stores its tracker as an append-only event log. Every
device owns exactly one object in S3 and writes only that object, so there is
never a concurrent writer on a key. Reconciliation happens on read, by
merging every device's log with `mergeEvents()`.

That means one shape does four jobs at once:

1. the S3 sync payload
2. the JSON export/import format
3. the convergence contract with Little Rhythm (a separate baby app)
4. the eventual relational import, if this ever grows a database

Changing a field touches all four. Add optional fields; don't reshape.

## The two invariants worth knowing

**Timestamps carry an explicit offset.** `ts` and `createdAt` are rejected by
the schema unless they end in `Z` or `±HH:MM`. Storing a naive local datetime
and tagging it with a configured timezone is the bug that silently corrupts
exported events in a sibling app; making it unrepresentable is cheaper than
remembering not to do it.

**Deletes are tombstones, never absences.** `deleted: true` plus a bumped
`revision`. With multi-writer merge, removing an event from one device's array
is indistinguishable from "this device hasn't seen it yet", so the next merge
would resurrect it. Use `liveEvents()` to filter tombstones at read time.

## Merge semantics

`mergeEvents(...logs)` dedupes by `id`, then sorts by `ts` with `id` as a
stable tiebreak. The winner for a duplicated id is decided by a **total**
order — revision, then `createdAt`, then a stable serialization — because
either device may sync first and both must reach identical state.
Commutativity and idempotence are covered by tests.

## Forward compatibility

`kind` is an open string, not an enum. `KNOWN_KINDS` lists what this app
renders, but the schema accepts anything, so a `nap` or `bottle` event written
by another app survives an import round-trip instead of being dropped.

## Usage

```js
import { mergeEvents, liveEvents, TimelineEventSchema } from "@baby/core";

const merged = mergeEvents(localLog, remoteLog);
const visible = liveEvents(merged);
```

## Tests

```
npm test
```
