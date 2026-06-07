// Pure game logic for the two-player elimination game.
// No I/O here so it can be unit-tested in isolation and reused by the Lambda.
//
// Flow: 4 choices, eliminations happen in the order B -> A -> B, leaving 1 winner.

// Whose turn it is after `n` eliminations have happened.
// 0 eliminations -> "B", 1 -> "A", 2 -> "B", 3 -> "done".
const TURN_ORDER = ["B", "A", "B"];

export function turnAfter(eliminationCount) {
  return eliminationCount < TURN_ORDER.length
    ? TURN_ORDER[eliminationCount]
    : "done";
}

// Create a new game item from 4 choice labels. Caller is role "A".
export function createGame(choices, now = Date.now()) {
  if (!Array.isArray(choices) || choices.length !== 4) {
    throw new GameError("EXACTLY_FOUR", "Provide exactly 4 choices.");
  }
  const cleaned = choices.map((c) => String(c ?? "").trim());
  if (cleaned.some((c) => c.length === 0)) {
    throw new GameError("EMPTY_CHOICE", "Choices cannot be empty.");
  }

  return {
    choices: cleaned,
    eliminated: [], // ordered: [{ index, by, at }]
    turn: turnAfter(0), // "B" moves first
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
  const turn = turnAfter(eliminated.length);
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
