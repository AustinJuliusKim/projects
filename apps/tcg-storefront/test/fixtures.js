// Response fixtures, shaped exactly like the backend: search responses are
// tcg_search query/shape.py shape_search(); card detail, quote and order
// errors follow tcg-pos-api routes/storefront.py + routes/models.py.

export const BOLT = "4457ed35-7c10-48c8-9776-456485fdf070";
export const PRINT_LEA = "b2f0c6a8-0000-4000-8000-000000000001";
export const PRINT_M10 = "b2f0c6a8-0000-4000-8000-000000000002";
export const ITEM_A = "11111111-1111-4111-8111-111111111111";
export const ITEM_B = "22222222-2222-4222-8222-222222222222";
export const ITEM_C = "33333333-3333-4333-8333-333333333333";

export const stockSearch = {
  mode: "stock",
  q: "bolt t:instant",
  total: 1,
  took_ms: 7,
  page: 1,
  page_size: 24,
  sort: "relevance",
  results: [
    {
      oracle_id: BOLT,
      name: "Lightning Bolt",
      mana_cost: "{R}",
      mana_value: 1,
      type_line: "Instant",
      oracle_text: "Lightning Bolt deals 3 damage to any target.",
      colors: ["R"],
      color_identity: ["R"],
      keywords: [],
      layout: "normal",
      is_dfc: false,
      legal: ["modern", "legacy", "vintage", "commander"],
      edhrec_rank: 12,
      image_small: "https://cards.scryfall.io/small/front/a/b/bolt.jpg",
      image_normal: "https://cards.scryfall.io/normal/front/a/b/bolt.jpg",
      price_cents: 199,
      in_stock: 5,
      tenant_id: "t-1",
      offers: [
        {
          printing_id: PRINT_M10,
          set: "m10",
          set_name: "Magic 2010",
          collector_number: "146",
          rarity: "common",
          lang: "en",
          finish: "nonfoil",
          condition: "NM",
          condition_rank: 5,
          available: 4,
          price_cents: 199,
        },
      ],
      score: 112.4,
      matched: ["exact", "name"],
    },
  ],
  facets: {
    set: [{ value: "m10", count: 1, selected: false }],
    rarity: [{ value: "common", count: 1, selected: false }],
    finish: [{ value: "nonfoil", count: 1, selected: false }],
    condition: [
      { value: "NM", count: 1, selected: true },
      { value: "LP", count: 0, selected: true },
    ],
    price: [{ value: "100-500", count: 1, label: "$1–5", selected: false }],
    colors: [{ value: "R", count: 1, selected: false }],
    types: [{ value: "instant", count: 1, selected: false }],
    keywords: [],
  },
  query: {
    clauses: [
      { key: null, op: ":", value: "bolt", negated: false, raw: "bolt", source: "q" },
      { key: "t", op: ":", value: "instant", negated: false, raw: "t:instant", source: "q" },
      {
        key: "condition",
        op: ":",
        value: ["NM", "LP"],
        negated: false,
        raw: "condition:NM,LP",
        source: "facet",
      },
    ],
  },
  warnings: [],
  did_you_mean: null,
  corrected: false,
};

export const catalogSearch = {
  ...stockSearch,
  mode: "catalog",
  q: "tarmogyof",
  results: [
    {
      oracle_id: "goyf",
      name: "Tarmogoyf",
      type_line: "Creature — Lhurgoyf",
      price_cents: 1500,
      in_stock: true,
      printing_count: 6,
      printings: [
        { printing_id: "p1", set: "fut", set_name: "Future Sight", finishes: ["nonfoil", "foil"] },
      ],
      score: 3.1,
    },
  ],
  query: {
    clauses: [
      { key: null, op: ":", value: "tarmogyof", negated: false, raw: "tarmogyof", source: "q" },
    ],
  },
  did_you_mean: "Tarmogoyf",
  corrected: true,
};

export const autocompleteList = [
  {
    oracle_id: BOLT,
    name: "Lightning Bolt",
    image_small: "x",
    price_cents: 199,
    in_stock: true,
    type_line: "Instant",
  },
  {
    oracle_id: "o2",
    name: "Lightning Helix",
    image_small: null,
    price_cents: null,
    in_stock: false,
    type_line: "Instant",
  },
];

const offer = (id, printingId, condition, finish, price, available) => ({
  inventory_item_id: id,
  printing_id: printingId,
  game: "mtg",
  condition,
  finish,
  lang: "en",
  price_cents: price,
  available,
});

export const cardDetail = {
  card: {
    oracle_id: BOLT,
    name: "Lightning Bolt",
    type_line: "Instant",
    oracle_text: "Lightning Bolt deals 3 damage to any target.",
    image_normal: "https://cards.scryfall.io/normal/front/a/b/bolt.jpg",
    image_small: "https://cards.scryfall.io/small/front/a/b/bolt.jpg",
    printings: [
      {
        id: PRINT_LEA,
        set_code: "lea",
        set_name: "Limited Edition Alpha",
        collector_number: "161",
        rarity: "common",
        finishes: ["nonfoil"],
        released_at: "1993-08-05",
        image_small: "https://cards.scryfall.io/small/lea.jpg",
        image_normal: "https://cards.scryfall.io/normal/lea.jpg",
      },
      {
        id: PRINT_M10,
        set_code: "m10",
        set_name: "Magic 2010",
        collector_number: "146",
        rarity: "common",
        finishes: ["nonfoil", "foil"],
        released_at: "2009-07-17",
        image_small: "https://cards.scryfall.io/small/m10.jpg",
        image_normal: "https://cards.scryfall.io/normal/m10.jpg",
      },
    ],
  },
  offers: {
    [PRINT_M10]: [
      offer(ITEM_A, PRINT_M10, "NM", "nonfoil", 199, 4),
      offer(ITEM_B, PRINT_M10, "LP", "foil", 199, 1),
    ],
    [PRINT_LEA]: [offer(ITEM_C, PRINT_LEA, "HP", "nonfoil", 45000, 1)],
  },
};

const quoteLine = (id, qty, status, available, price) => ({
  inventory_item_id: id,
  qty,
  status,
  available,
  unit_price_cents: price,
  line_total_cents: status === "ok" || status === "price_changed" ? price * qty : null,
  printing_id: PRINT_M10,
  condition: "NM",
  finish: "nonfoil",
  lang: "en",
});

export const quoteWithIssues = {
  ok: false,
  total_cents: 398,
  lines: [
    quoteLine(ITEM_A, 2, "ok", 4, 199),
    quoteLine(ITEM_B, 3, "insufficient", 1, 199),
    quoteLine(ITEM_C, 1, "price_changed", 1, 40000),
  ],
};

export const order409 = {
  detail: {
    message: "some lines can't be reserved",
    issues: quoteWithIssues.lines.slice(1),
  },
};
