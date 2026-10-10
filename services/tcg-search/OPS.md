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

- a role that can only `SELECT` the six tables the extract reads, and
- a contract test (`tests/test_extract_contract.py`) that runs the extract
  SQL against a database built from mtg-api's own migrations, so a schema
  change there fails here.

Created on the local cluster (2026-10-10) as postgres on mtg_dev:

```sql
CREATE ROLE mtg_search_reader LOGIN PASSWORD 'mtg_search_reader';
GRANT CONNECT ON DATABASE mtg_dev TO mtg_search_reader;
GRANT USAGE ON SCHEMA public TO mtg_search_reader;
GRANT SELECT ON cards, printings, sets, skus, price_current, price_sources
  TO mtg_search_reader;
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

- Indices are versioned `catalog-YYYYMMDDTHHMMSSZ`; the alias `catalog`
  points at exactly one. Each build keeps the previous index for rollback
  and deletes older ones (`--keep`, default 2).
- A build refuses to swap if any bulk item failed, or if the new doc count
  is below 95% of the current alias's (a truncated extract must never
  replace a good index). The failed index is left in place for inspection
  and is cleaned by the next successful build.
- Each index's `_meta` records the build time, source DB (no password),
  doc/printing counts, the latest price snapshot id, and the package
  version — `catalog status` prints them.

## 4. Nightly reindex (systemd)

See section 5 (added in M3).

## Test databases

- `TEST_OPENSEARCH_URL=http://localhost:9200`: integration tests create
  `itest_<uuid>_*` indices and delete them in teardown; they never touch
  `catalog*` or `listings*`.
- `TEST_CATALOG_DATABASE_URL`: a scratch database built from mtg-api's
  migrations + its test fixtures (never mtg_dev). Recreate it with
  `scripts/make_contract_db.sh` (see the script header).
