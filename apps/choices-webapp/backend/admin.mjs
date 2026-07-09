// Owner-only ops aggregates for the activity dashboard.
//
// Everything here is a PURE reducer over raw PAIR# items — no I/O — so it
// unit-tests without DynamoDB and structurally cannot leak a record: it only
// ever returns counts and frequency aggregates, never a game/user/code/token.
// This is the load-bearing enforcement of constitution rules 6 & 9 ("no
// tracking", "nothing that converts play into evidence") for the dashboard —
// anonymous aggregates only, no identifiable per-user view.

const DEFAULT_CHOICE_FLOOR = 3;
const TOP_CHOICES_CAP = 15;

// Owner allowlist check. Gate on the Cognito `sub` (stable) rather than email
// (user-mutable). `adminSubsCsv` is the ADMIN_SUBS env value.
export function isAdmin(sub, adminSubsCsv) {
  if (!sub) return false;
  const allow = String(adminSubsCsv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allow.includes(sub);
}

// pairItems: raw PAIR# items projected to { pk, game, userA, userB }.
// Returns anonymous aggregates only.
export function aggregateActive(pairItems = [], { choiceFloor = DEFAULT_CHOICE_FLOOR } = {}) {
  let gamesInProgress = 0;
  const byTurn = { A: 0, B: 0, done: 0 };
  const users = new Set();
  const choiceCounts = new Map(); // label -> # distinct active games it appears in

  for (const it of pairItems) {
    const g = it?.game;
    if (!g || g.status !== "active") continue;
    gamesInProgress += 1;
    const turn = g.turn === "A" || g.turn === "B" ? g.turn : "done";
    byTurn[turn] += 1;
    if (it.userA) users.add(it.userA);
    if (it.userB) users.add(it.userB);
    // Count each distinct choice at most once per game (distinct-pairing count),
    // so the k-anon floor below counts games, not repeated labels.
    const seen = new Set();
    for (const c of g.choices ?? []) {
      const label = String(c ?? "").trim();
      const key = label.toLowerCase();
      if (!label || seen.has(key)) continue;
      seen.add(key);
      choiceCounts.set(label, (choiceCounts.get(label) ?? 0) + 1);
    }
  }

  // k-anonymity floor: only surface a choice appearing across >= floor distinct
  // active games. Text-only aggregate, same posture as the suggestion trie.
  const topChoicesInPlay = [...choiceCounts.entries()]
    .filter(([, n]) => n >= choiceFloor)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_CHOICES_CAP)
    .map(([label, count]) => ({ label, count }));

  return {
    recentPairings: pairItems.length, // all PAIR# scanned (active + waiting + finished-within-TTL)
    gamesInProgress,
    activeByTurn: byTurn,
    distinctActiveUsers: users.size,
    topChoicesInPlay,
    choiceFloor,
  };
}
