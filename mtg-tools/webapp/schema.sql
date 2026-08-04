-- Collection manager schema.
--
-- MONEY IS ALWAYS `INTEGER` CENTS. SQLite has no decimal type, and REAL would
-- reintroduce exactly the float drift `binders` uses Decimal to prevent — the
-- collection sums to $9,737.83, which in float is 9737.829999999999927. A test
-- asserts no column holding money is ever declared REAL.
--
-- Identity keys are the ones `binders` already computes: `Card.identity` for
-- singles and `SealedHolding.identity` (the MTGJSON UUID) for sealed. Reusing
-- them is what lets a re-import attach to existing rows instead of duplicating.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER NOT NULL
);

-- --- imports -----------------------------------------------------------------
-- Nothing an import contains reaches `holdings` until it is committed.

CREATE TABLE IF NOT EXISTS imports (
    id          INTEGER PRIMARY KEY,
    filename    TEXT    NOT NULL,
    sha256      TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('singles', 'sealed')),
    dialect     TEXT    NOT NULL DEFAULT '',
    row_count   INTEGER NOT NULL DEFAULT 0,
    status      TEXT    NOT NULL DEFAULT 'staged'
                CHECK (status IN ('staged', 'committed', 'discarded', 'reverted')),
    created_at  TEXT    NOT NULL,
    committed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_imports_sha ON imports (sha256);
CREATE INDEX IF NOT EXISTS idx_imports_status ON imports (status);

CREATE TABLE IF NOT EXISTS staged_rows (
    id          INTEGER PRIMARY KEY,
    import_id   INTEGER NOT NULL REFERENCES imports (id) ON DELETE CASCADE,
    line_no     INTEGER NOT NULL,
    raw         TEXT    NOT NULL,          -- JSON: the CSV row as read
    parsed      TEXT    NOT NULL,          -- JSON: normalized fields
    issues      TEXT    NOT NULL DEFAULT '[]',   -- JSON: codes from validate()/resolve()
    resolution  TEXT    NOT NULL DEFAULT '{}',   -- JSON: the human's fixes
    state       TEXT    NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'resolved', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_staged_import ON staged_rows (import_id);

-- --- canonical holdings ------------------------------------------------------

CREATE TABLE IF NOT EXISTS holdings (
    id               INTEGER PRIMARY KEY,
    identity         TEXT    NOT NULL UNIQUE,   -- Card.identity, joined
    title            TEXT    NOT NULL,
    edition          TEXT    NOT NULL DEFAULT '',
    set_name         TEXT    NOT NULL DEFAULT '',
    collector_number TEXT    NOT NULL DEFAULT '',
    rarity           TEXT    NOT NULL DEFAULT '',
    foil             INTEGER NOT NULL DEFAULT 0 CHECK (foil IN (0, 1)),
    finish           TEXT    NOT NULL DEFAULT '',
    quantity         INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    price_cents      INTEGER,                   -- NULL means unknown, not free
    condition        TEXT    NOT NULL DEFAULT 'near_mint',
    language         TEXT    NOT NULL DEFAULT 'en',
    scryfall_id      TEXT    NOT NULL DEFAULT '',
    manabox_id       TEXT    NOT NULL DEFAULT '',
    sources          TEXT    NOT NULL DEFAULT '',
    added_at         TEXT,
    source_import_id INTEGER REFERENCES imports (id),
    version          INTEGER NOT NULL DEFAULT 1,   -- optimistic lock
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_holdings_title ON holdings (title);
CREATE INDEX IF NOT EXISTS idx_holdings_edition ON holdings (edition);
CREATE INDEX IF NOT EXISTS idx_holdings_price ON holdings (price_cents);

CREATE TABLE IF NOT EXISTS sealed (
    id               INTEGER PRIMARY KEY,
    identity         TEXT    NOT NULL UNIQUE,   -- MTGJSON uuid, or unresolved:<nick>
    mtgjson_uuid     TEXT    NOT NULL DEFAULT '',
    raw_name         TEXT    NOT NULL,
    product_name     TEXT    NOT NULL DEFAULT '',
    set_code         TEXT    NOT NULL DEFAULT '',
    set_name         TEXT    NOT NULL DEFAULT '',
    release_year     TEXT    NOT NULL DEFAULT '',
    quantity         INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    condition        TEXT    NOT NULL DEFAULT 'sealed',
    price_cents      INTEGER,
    price_date       TEXT,
    price_source     TEXT    NOT NULL DEFAULT '',
    cost_basis_cents INTEGER,
    purchase_url     TEXT    NOT NULL DEFAULT '',
    notes            TEXT    NOT NULL DEFAULT '',
    resolved         INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
    source_import_id INTEGER REFERENCES imports (id),
    version          INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sealed_name ON sealed (raw_name);

-- --- decisions and sales -----------------------------------------------------
-- `subject_kind` is 'holding' or 'sealed'; there is no FK because it is
-- polymorphic, so deletes clean up explicitly rather than by cascade.

CREATE TABLE IF NOT EXISTS verdicts (
    subject_kind TEXT    NOT NULL CHECK (subject_kind IN ('holding', 'sealed')),
    subject_id   INTEGER NOT NULL,
    verdict      TEXT    NOT NULL CHECK (verdict IN ('keep', 'sell', 'undecided')),
    decided_at   TEXT    NOT NULL,
    PRIMARY KEY (subject_kind, subject_id)
);

CREATE TABLE IF NOT EXISTS sales (
    id                  INTEGER PRIMARY KEY,
    subject_kind        TEXT    NOT NULL CHECK (subject_kind IN ('holding', 'sealed')),
    subject_id          INTEGER NOT NULL,
    -- Denormalized at listing time on purpose. A fully-sold item is deleted
    -- from holdings, and without its name here the sale would vanish from the
    -- ledger — losing exactly the realized-gain record the ledger exists for.
    subject_name        TEXT    NOT NULL DEFAULT '',
    subject_set         TEXT    NOT NULL DEFAULT '',
    quantity            INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    channel             TEXT    NOT NULL DEFAULT '',
    status              TEXT    NOT NULL DEFAULT 'listed'
                        CHECK (status IN ('listed', 'sold', 'cancelled')),
    listed_at           TEXT,
    listed_cents        INTEGER,
    sold_at             TEXT,
    sold_cents          INTEGER,
    fees_cents          INTEGER NOT NULL DEFAULT 0,
    shipping_cents      INTEGER NOT NULL DEFAULT 0,
    net_cents           INTEGER,
    cost_basis_cents    INTEGER,
    realized_gain_cents INTEGER,
    notes               TEXT    NOT NULL DEFAULT '',
    created_at          TEXT    NOT NULL,
    updated_at          TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_subject ON sales (subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales (status);

CREATE TABLE IF NOT EXISTS price_history (
    id           INTEGER PRIMARY KEY,
    subject_kind TEXT    NOT NULL CHECK (subject_kind IN ('holding', 'sealed')),
    subject_id   INTEGER NOT NULL,
    price_cents  INTEGER NOT NULL,
    observed_at  TEXT    NOT NULL,
    source       TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_price_hist ON price_history (subject_kind, subject_id, observed_at);

-- --- the undo log ------------------------------------------------------------
-- Written inside the same transaction as every mutation. `inverse` carries
-- enough to reverse the operation exactly; see webapp/operations.py.

CREATE TABLE IF NOT EXISTS operations (
    id          INTEGER PRIMARY KEY,
    kind        TEXT    NOT NULL,
    summary     TEXT    NOT NULL,
    affected    INTEGER NOT NULL DEFAULT 0,
    inverse     TEXT    NOT NULL,          -- JSON
    created_at  TEXT    NOT NULL,
    reverted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_operations_created ON operations (created_at DESC);
