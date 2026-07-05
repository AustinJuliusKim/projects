// Pure per-user stats logic (no I/O, mirrors game.mjs's testability rule).
//
// Streak = consecutive UTC days with at least one finished game (the game
// has no per-player winner — the winning *choice* is shared — so play
// streaks are the personal metric; choice win counts are the "advanced"
// stat). recentGames is an embedded, capped list: no GSI needed at this
// scale, and the durable GAME# archive can back a full-history query later.

export const RECENT_GAMES_CAP = 50;
export const TOP_WINNERS_CAP = 30;

export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function prevDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function emptyStats() {
  return {
    gamesPlayed: 0,
    currentStreak: 0,
    bestStreak: 0,
    lastPlayedDay: null,
    topWinners: {},
  };
}

// Fold one completed game into a user record. rec: { pairingId, number,
// winnerLabel, choices, completedAt }. Returns a NEW user object.
export function applyCompletedGame(user, rec, now = Date.now()) {
  const s = user.stats ?? emptyStats();
  const day = utcDay(rec.completedAt ?? now);

  let currentStreak;
  if (s.lastPlayedDay === day) {
    currentStreak = s.currentStreak || 1;
  } else if (s.lastPlayedDay === prevDay(day)) {
    currentStreak = (s.currentStreak || 0) + 1;
  } else {
    currentStreak = 1;
  }

  return {
    ...user,
    stats: {
      gamesPlayed: (s.gamesPlayed || 0) + 1,
      currentStreak,
      bestStreak: Math.max(s.bestStreak || 0, currentStreak),
      lastPlayedDay: day,
      topWinners: bumpWinner(s.topWinners, rec.winnerLabel),
    },
    recentGames: [rec, ...(user.recentGames || [])].slice(0, RECENT_GAMES_CAP),
    updatedAt: now,
  };
}

// Count a winning label, evicting the least-frequent labels past the cap so
// the map can't grow unboundedly on a single item.
function bumpWinner(map = {}, label) {
  const next = { ...map, [label]: (map[label] || 0) + 1 };
  const keys = Object.keys(next);
  if (keys.length <= TOP_WINNERS_CAP) return next;
  const keep = keys.sort((a, b) => next[b] - next[a]).slice(0, TOP_WINNERS_CAP);
  return Object.fromEntries(keep.map((k) => [k, next[k]]));
}
