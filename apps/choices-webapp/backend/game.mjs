// Pure game logic for the two-player elimination game.
// No I/O here so it can be unit-tested in isolation and reused by the Lambda.
//
// Flow: 4 choices, 3 eliminations leave 1 winner. The player who STARTS a game
// (picks the choices) does NOT eliminate first — the OTHER player eliminates
// first. So within-game order is [nonStarter, starter, nonStarter].

// Whose turn it is after `n` eliminations, given who started the game.
// n=0 -> nonStarter, 1 -> starter, 2 -> nonStarter, 3 -> "done".
export function turnAfter(eliminationCount, startedBy) {
  const nonStarter = otherRole(startedBy);
  const order = [nonStarter, startedBy, nonStarter];
  return eliminationCount < order.length ? order[eliminationCount] : "done";
}

// Create a new game from 4 choice labels.
// opts.startedBy: "A" | "B" (who picked the choices; the other moves first).
// opts.number: monotonic game number within a pairing.
export function createGame(choices, opts = {}, now = Date.now()) {
  const { startedBy = "A", number = 1 } = opts;
  if (startedBy !== "A" && startedBy !== "B") {
    throw new GameError("BAD_ROLE", "startedBy must be 'A' or 'B'.");
  }
  if (!Array.isArray(choices) || choices.length !== 4) {
    throw new GameError("EXACTLY_FOUR", "Provide exactly 4 choices.");
  }
  const cleaned = choices.map((c) => String(c ?? "").trim());
  if (cleaned.some((c) => c.length === 0)) {
    throw new GameError("EMPTY_CHOICE", "Choices cannot be empty.");
  }

  return {
    number,
    startedBy,
    choices: cleaned,
    eliminated: [], // ordered: [{ index, by, at }]
    turn: turnAfter(0, startedBy), // non-starter moves first
    status: "active",
    winnerIndex: null,
    createdAt: now,
  };
}

// Indices not yet eliminated.
export function liveIndices(game) {
  const dead = new Set(game.eliminated.map((e) => e.index));
  return game.choices.map((_, i) => i).filter((i) => !dead.has(i));
}

// Apply an elimination by `role` of choice `index`. Returns a NEW game object.
// Validates: game active, correct turn, index in range, index still live.
export function applyElimination(game, role, index, now = Date.now()) {
  if (game.status !== "active") {
    throw new GameError("GAME_COMPLETE", "This game is already complete.");
  }
  if (role !== "A" && role !== "B") {
    throw new GameError("BAD_ROLE", "Role must be 'A' or 'B'.");
  }
  if (role !== game.turn) {
    throw new GameError("NOT_YOUR_TURN", `It is not ${role}'s turn.`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= game.choices.length) {
    throw new GameError("BAD_INDEX", "Choice index out of range.");
  }
  if (game.eliminated.some((e) => e.index === index)) {
    throw new GameError("ALREADY_ELIMINATED", "That choice is already eliminated.");
  }

  const eliminated = [...game.eliminated, { index, by: role, at: now }];
  const turn = turnAfter(eliminated.length, game.startedBy);
  const done = turn === "done";
  const winnerIndex = done ? liveIndicesFrom(game.choices, eliminated)[0] : null;

  return {
    ...game,
    eliminated,
    turn,
    status: done ? "complete" : "active",
    winnerIndex,
  };
}

// Helper used during winner computation (operates on a candidate eliminated list).
function liveIndicesFrom(choices, eliminated) {
  const dead = new Set(eliminated.map((e) => e.index));
  return choices.map((_, i) => i).filter((i) => !dead.has(i));
}

// Platforms the winner-screen "order" buttons can report (growth plan §6).
export const LINK_PLATFORMS = ["ubereats", "doordash", "grubhub", "opentable"];

// Support/interest beacons (growth plan §8): tip-jar clicks and the premium
// tease ride the same pipeline but aren't tied to a finished game — they can
// fire from the created screen before any cut is made.
export const SUPPORT_PLATFORMS = ["tip-venmo", "tip-stripe", "premium-interest"];

// Record an outbound order-link click. Order platforms are only valid once
// the game is complete — the order card never renders before a winner exists.
// Returns a NEW game object.
export function applyLinkClick(game, role, platform, now = Date.now()) {
  const isSupport = SUPPORT_PLATFORMS.includes(platform);
  if (!isSupport && !LINK_PLATFORMS.includes(platform)) {
    throw new GameError("BAD_PLATFORM", "Unknown platform.");
  }
  if (role !== "A" && role !== "B") {
    throw new GameError("BAD_ROLE", "Role must be 'A' or 'B'.");
  }
  if (!isSupport && game.status !== "complete") {
    throw new GameError("NO_WINNER_YET", "The game has no winner yet.");
  }
  const linkClicks = [...(game.linkClicks ?? []), { platform, by: role, at: now }];
  return { ...game, linkClicks };
}

// Snapshot of a finished game for the GAME# archive. Rematch overwrites
// pairing.game in place, so history/streaks need this captured at the moment
// of completion. linkClicks are deliberately excluded — they can land after
// completion and stay on the live game object (analytics, not history).
export function gameSummary(game, now = Date.now()) {
  if (game.status !== "complete") {
    throw new GameError("NOT_COMPLETE", "Only complete games can be archived.");
  }
  return {
    number: game.number,
    startedBy: game.startedBy,
    choices: game.choices,
    eliminated: game.eliminated,
    winnerIndex: game.winnerIndex,
    winnerLabel: game.choices[game.winnerIndex],
    createdAt: game.createdAt,
    completedAt: now,
  };
}

// The other player's role.
export function otherRole(role) {
  return role === "A" ? "B" : "A";
}

export class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GameError";
    this.code = code;
  }
}
