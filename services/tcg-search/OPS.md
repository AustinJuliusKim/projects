# tcg-search — ops runbook

Local-only for now: OpenSearch runs in WSL (Ubuntu 24.04) on
`127.0.0.1:9200`. A managed domain (~$25–30/mo) is a later, explicit
decision (plan §1, budget lock); moving there is a change of
`OPENSEARCH_URL` / `OPENSEARCH_USER` / `OPENSEARCH_PASSWORD` /
`OPENSEARCH_VERIFY` only.

## 1. Install OpenSearch (done 2026-10-10 — 3.9.0)

```sh
sudo services/tcg-search/deploy/local/install_opensearch.sh
```

What it does (all files it installs live in `deploy/local/`):

1. Adds OpenSearch's signed apt repo (`artifacts.opensearch.org`, 3.x
   channel, keyring in `/usr/share/keyrings/`) — a third-party repo, the
   same kind of step as PGDG.
2. Installs the newest 3.x and `apt-mark hold`s it. The package bundles its
   JDK; no system Java. Its demo-security postinst wants an admin password
   even though security is removed; a random throwaway one is passed.
3. Removes unused plugins (18 of them, incl. `opensearch-security`, ML,
   SQL, alerting, anomaly detection, performance-analyzer). Kept: knn,
   index-management, job-scheduler, custom-codecs, search-relevance, ubi,
   query-insights, system-templates.
4. Installs `opensearch.yml` (single node, `127.0.0.1`, no security,
   `action.auto_create_index: false`, absolute disk watermarks 5/3/2 GB
   because percentage thresholds misfire on the WSL disk, data under
   `/var/lib/opensearch`), `heap.options` (1 GB), and
   `vm.max_map_count=262144` in `/etc/sysctl.d/99-opensearch.conf`.
5. `systemctl enable --now opensearch`, waits for health.

Originally run as two scripts (install, then a plugin trim); the committed
script is the two merged. Measured: ~1.4 GB java RSS idle after the trim.

Check: `make health` (or `curl -s localhost:9200/_cluster/health`).

### Day to day

- Stop when not needed (frees ~1.5 GB): `sudo systemctl stop opensearch`.
  Search callers then get `OpenSearchUnavailable` (the storefront maps it to
  503). `sudo systemctl disable opensearch` to keep it off across WSL
  restarts.
- Cap WSL's memory in `%UserProfile%\.wslconfig` (`[wsl2] memory=8GB`) so
  OpenSearch + Postgres can't starve Windows.
- Logs: `sudo journalctl -u opensearch`, `/var/log/opensearch/tcg-local.log`.
- Upgrades are deliberate: `sudo apt-mark unhold opensearch && sudo apt
  install opensearch=<ver> && sudo apt-mark hold opensearch`, then re-run
  the plugin removal (an upgrade reinstalls bundled plugins), then
  `make catalog-build` (indices are rebuildable; nothing in OpenSearch is a
  source of truth).
- Uninstall: `sudo apt-mark unhold opensearch && sudo apt purge opensearch
  && sudo rm -rf /var/lib/opensearch /etc/apt/sources.list.d/opensearch-3.x.list`.

## 2. Read-only catalog role

The catalog builder reads mtg_dev directly — a documented exception to the
POS's "mtg-api over HTTP only" rule (plan §4): a nightly full scan of 35k
cards / 112k printings / ~1M price rows is not an HTTP-API job. The
exception is bounded by:

- a role that can only `SELECT` the tables the extract reads (plus
  `price_snapshots`, for the snapshot id recorded in the index `_meta`), and
- a contract test (`tests/test_extract_contract.py`) that runs the extract
  SQL against a database built from mtg-api's own migrations, so a schema
  change there fails here.

Created on the local cluster (2026-10-10) as postgres on mtg_dev:

```sql
CREATE ROLE mtg_search_reader LOGIN PASSWORD 'mtg_search_reader';
GRANT CONNECT ON DATABASE mtg_dev TO mtg_search_reader;
GRANT USAGE ON SCHEMA public TO mtg_search_reader;
GRANT SELECT ON cards, printings, sets, skus, price_current, price_sources,
  price_snapshots TO mtg_search_reader;
ALTER ROLE mtg_search_reader SET default_transaction_read_only = on;
```

The password is local-only (localhost Postgres in WSL). Against Supabase,
create the same role with a real password and set `CATALOG_DATABASE_URL`.
If mtg-api adds a table the extract needs, grant it here too.

## 3. Catalog index

```sh
make catalog-build      # build catalog-<UTC timestamp>, verify, swap alias
make catalog-status     # alias target + kept versions + doc counts
make catalog-rollback   # alias -> previous version
```

- Indices are versioned `catalog-YYYYMMDD-HHMMSSmmm` (UTC); the alias
  `catalog` points at exactly one. Each successful build keeps the previous
  good index for rollback and deletes the rest (`--keep`, default 2).
- A build refuses to swap if any bulk item failed, the indexed count
  differs from the extracted count, the extract is empty, or the new count
  is below 95% of the current alias's (a truncated extract must never
  replace a good index). The failed index is marked `_meta.failed`, left
  for inspection, never used by `swap`/`rollback`, and deleted by the next
  successful build. Exit code 2 on a guard failure.
- Finished indices are force-merged to one segment: ~21 MB for 35k cards
  + 104k paper printings (138,911 Lucene docs incl. nested), build ~16–20 s.
- Each index's `_meta` records the build time, source DB (no password),
  doc/printing/priced counts, the latest price snapshot id, bulk errors,
  nickname targets missing from the catalog, and the package version —
  `catalog status` prints them.

## 4. Nightly reindex (systemd) — installed 2026-10-10

```sh
sudo deploy/local/install_reindex.sh      # from services/tcg-search
sudo systemctl start tcg-search-reindex   # run now
journalctl -u tcg-search-reindex -n 20
```

- `tcg-search-reindex.service` (oneshot, `User=austi`) runs
  `.venv/bin/python -m tcg_search catalog build --swap` from this package.
  It is chained to the existing daily price job by a drop-in,
  `/etc/systemd/system/mtg-prices-daily.service.d/search.conf`
  (`[Unit] OnSuccess=tcg-search-reindex.service`), so the reindex runs
  after every *successful* price snapshot. `mtg-prices-daily.service` and
  `~/.local/bin/mtg-prices-daily` are not modified (checksums unchanged).
- If OpenSearch is stopped (on purpose, to save memory) the unit's
  `ExecCondition` skips the run cleanly instead of starting it; the next
  successful price job, or a manual start, rebuilds.
- The unit file is a template (`@SERVICE_DIR@`, `@POS_DIR@`, `@USER@`).
  Since 2026-10-10 (M5) it is installed from the **`projects-pos`
  worktree** (`/mnt/c/Users/austi/personal/projects-pos/services/tcg-search`
  and `.../tcg-pos-api`, each with its own `.venv`); re-run the installer
  from wherever the checkout moves.
- **Listings rebuild (M5 hook):** a second `ExecStart=` runs
  `tcg_pos_api.search.listings rebuild` after a successful catalog build,
  so listings docs pick up the new card text/images (DATABASE_URL in the
  unit: the local `tcg_pos_worker_login` on `tcg_pos_dev`, see §5). It waits
  for the follower's current batch via the advisory lock.
- Remove: `sudo rm /etc/systemd/system/tcg-search-reindex.service
  /etc/systemd/system/mtg-prices-daily.service.d/search.conf && sudo
  systemctl daemon-reload`.

## 5. Listings follower (systemd) — installed 2026-10-10

`tcg-search-listings.service` (`Type=simple`, `Restart=always`, enabled)
runs `tcg_pos_api.search.listings follow` from `@POS_DIR@`: LISTEN
`search_outbox` + a 5 s poll, drains each batch into the `listings` alias,
exits cleanly on SIGTERM. The same installer installs it
(`sudo deploy/local/install_reindex.sh`), enables it and restarts it.

```sh
systemctl status tcg-search-listings
sudo journalctl -u tcg-search-listings -f
cd ../tcg-pos-api && DATABASE_URL=postgres://tcg_pos_worker_login:tcg_pos_worker_login@localhost:54329/tcg_pos_dev \
  .venv/bin/python -m tcg_pos_api.search.listings status   # backlog, oldest event, alias, docs
```

- Database: the persistent local POS dev DB `tcg_pos_dev` (localhost:54329,
  migrated with tcg-pos-api's `scripts/migrate.py` as postgres), never the
  test DB. Login role, created 2026-10-10 as postgres:
  ```sql
  CREATE ROLE tcg_pos_worker_login LOGIN PASSWORD 'tcg_pos_worker_login';
  GRANT CONNECT ON DATABASE tcg_pos_dev TO tcg_pos_worker_login;
  GRANT tcg_pos_worker, tcg_pos_app TO tcg_pos_worker_login;
  ```
  (not superuser, not BYPASSRLS; the password is local-only.)
- OpenSearch stopped on purpose: the follower keeps running, logs the
  failure once and leaves events queued; they drain when it is back.
- WSL shuts the distro down when idle; the unit stops cleanly ("stopped" in
  the journal) and starts again with the distro. Nothing is lost: events
  wait in the outbox.
- If the `listings` alias is missing (first run, or deleted), `follow` /
  `drain` build it first (a full `rebuild`).
- Remove: `sudo systemctl disable --now tcg-search-listings && sudo rm
  /etc/systemd/system/tcg-search-listings.service && sudo systemctl
  daemon-reload`.

## Test databases

- `TEST_OPENSEARCH_URL=http://localhost:9200`: integration tests create
  `itest_<uuid>_*` indices and delete them in teardown; they never touch
  `catalog*` or `listings*`.
- `TEST_CATALOG_DATABASE_URL`: a scratch database built from mtg-api's
  migrations + its test fixtures (never mtg_dev). Recreate it with
  `scripts/make_contract_db.sh` (see the script header).
- `search_contract_test` (localhost:54329, owner postgres) was created
  2026-10-10 from the projects-prices worktree's mtg-api (read-only use) and is
  left in place for `make test-os`; drop it with `DROP DATABASE
  search_contract_test` when no longer needed.
