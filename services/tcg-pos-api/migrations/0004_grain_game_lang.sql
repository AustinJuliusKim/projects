-- 0004_grain_game_lang: put `game` in the inventory grain and constrain the
-- free-text grain columns.
--
-- Why it looks like this:
--   * `game` was stored but not part of inventory_item_grain, so two adjusts
--     differing only in game hit the same row and the second silently kept
--     the first's game. printing_id comes from a per-game catalog, so game is
--     part of the identity: the grain becomes tenant × location × game ×
--     printing × condition × finish × language, and the API's lock query
--     matches on game too.
--   * Allowed games are a CHECK (mirrored by models.Game). Only 'mtg' has a
--     catalog today; adding a game later is a CHECK change, not a grain change.
--   * `lang` was free text, so "EN", "en " and "english" were three grains for
--     the same stock. It is now a lowercase 2–3 letter code (Scryfall's set:
--     en, ja, zhs, ph, ...); the API lower-cases and trims before validating.
--   * Same CHECKs on buylist_offer, which carries the same grain columns.
--   * Scaffold stage, no deployed data: the CHECKs are validated immediately
--     rather than added NOT VALID.

ALTER TABLE inventory_item
    ADD CONSTRAINT inventory_item_game_check CHECK (game IN ('mtg')),
    ADD CONSTRAINT inventory_item_lang_check CHECK (lang ~ '^[a-z]{2,3}$'),
    DROP CONSTRAINT inventory_item_grain,
    ADD CONSTRAINT inventory_item_grain
        UNIQUE (tenant_id, location_id, game, printing_id, condition, finish, lang);

ALTER TABLE buylist_offer
    ADD CONSTRAINT buylist_offer_game_check CHECK (game IN ('mtg')),
    ADD CONSTRAINT buylist_offer_lang_check CHECK (lang ~ '^[a-z]{2,3}$');
