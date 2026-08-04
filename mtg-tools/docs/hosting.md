# Hosting the SPA

The app is static files plus a Web Worker owning SQLite in the browser's OPFS
— there is no server to run. Any static host works; Cloudflare Pages is the
one wired up.

## Why no special headers

The worker uses the **`opfs-sahpool`** VFS (synchronous access handles inside
a dedicated worker). Unlike the `opfs` VFS, it needs **no cross-origin
isolation** — no COOP/COEP headers, no SharedArrayBuffer — so the site works
from any static host, including ones that can't set headers at all. If anyone
ever switches to the `opfs` VFS, GitHub Pages would then need the
`coi-serviceworker` shim; Cloudflare Pages would just need two lines in
`frontend/public/_headers`.

`_headers` currently only sets immutable caching on the fingerprinted
`/assets/*` bundle.

## One-time Cloudflare setup

1. Dashboard → Workers & Pages → **Create** → Pages → *Direct Upload*, name it
   `mtg-tools`.
2. Create an API token with **Cloudflare Pages: Edit** scope.
3. Repo → Settings → Secrets → Actions: add `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`.
4. Push to main (or run the `deploy` workflow manually). Until the secrets
   exist the workflow no-ops with a note.

## Browser floor

`FileSystemSyncAccessHandle` in a worker: Chrome/Edge 102+, Safari 16.4+,
Firefox 111+. Older browsers get an in-memory database and a warning that
nothing persists.

## The durable copy

Browser storage is durable-with-a-promise (`navigator.storage.persist()` is
requested and the outcome surfaced in-app). The **export bundle** is the copy
the user controls: every table as CSV, the ledger, and `collection.sqlite` —
the real database image, which opens in stock `sqlite3` and round-trips back
in through the first-run import.
