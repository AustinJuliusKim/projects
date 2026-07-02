// Single Lambda (Function URL) for the elimination game.
//
// Model: a persistent A<->B PAIRING hosts a series of games. Identity (tokenA/
// tokenB) and push subscriptions live at the pairing level so they survive
// rematches. B joins by entering a short human CODE inside the app.
//
// Actions: createPairing | claimSeat | getState | eliminate | rematch | subscribe
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { createGame, applyElimination, otherRole, GameError } from "./game.mjs";
import { sendPush } from "./push.mjs";

const TABLE = process.env.TABLE_NAME;
const TTL_DAYS = 30;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const pairPk = (id) => `PAIR#${id}`;
const codePk = (code) => `CODE#${code}`;
const subPk = (pairingId, role) => `SUB#${pairingId}#${role}`;
const ttlEpoch = () => Math.floor(Date.now() / 1000) + TTL_DAYS * 24 * 3600;

// Human-friendly join code: WORD-NN (e.g. "PLUM-42").
const CODE_WORDS = [
  "PLUM", "KIWI", "MINT", "SAGE", "RUBY", "JADE", "MOSS", "FERN",
  "PEAR", "LIME", "ROSE", "CLAY", "DUNE", "REEF", "PINE", "OPAL",
];
function generateCode() {
  const word = CODE_WORDS[Math.floor(Math.random() * CODE_WORDS.length)];
  const num = Math.floor(10 + Math.random() * 90); // 10..99
  return `${word}-${num}`;
}

export async function handler(event) {
  const method = event?.requestContext?.http?.method;
  if (method === "OPTIONS") return reply(204, "");

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return reply(400, { error: "Invalid JSON" });
  }

  try {
    switch (body.action) {
      case "createPairing":
        return reply(200, await doCreatePairing(body));
      case "claimSeat":
        return reply(200, await doClaimSeat(body));
      case "getState":
        return reply(200, await doGetState(body));
      case "eliminate":
        return reply(200, await doEliminate(body));
      case "rematch":
        return reply(200, await doRematch(body));
      case "subscribe":
        return reply(200, await doSubscribe(body));
      default:
        return reply(400, { error: "Unknown action" });
    }
  } catch (err) {
    if (err instanceof GameError) {
      return reply(409, { error: err.message, code: err.code });
    }
    if (err instanceof HttpError) {
      return reply(err.status, { error: err.message, code: err.code });
    }
    console.error("unhandled error", err);
    return reply(500, { error: "Internal error" });
  }
}

// --- Actions ---

async function doCreatePairing(body) {
  const game = createGame(body.choices, { startedBy: "A", number: 1 });
  const pairingId = shortId(12);
  const code = await reserveUniqueCode(pairingId);

  // No tokens minted here — the creator (and the guest) claim a seat via the
  // code, so a single device can never accidentally hold both seats.
  const item = {
    pk: pairPk(pairingId),
    code,
    tokenA: null,
    tokenB: null,
    gameNumber: 1,
    nextStarter: "B", // after game 1 (A-started), B starts the next
    game,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ttl: ttlEpoch(),
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));

  return { pairingId, code, state: publicState(item) };
}

async function doClaimSeat(body) {
  const code = normalizeCode(body.code);
  if (!code) throw new HttpError(400, "Missing code");
  const seat = body.seat;
  if (seat !== "A" && seat !== "B") {
    throw new HttpError(400, "seat must be 'A' or 'B'");
  }

  const codeRes = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: codePk(code) } })
  );
  if (!codeRes.Item) throw new HttpError(404, "Invalid code", "INVALID_CODE");

  const pairing = await loadPairing(codeRes.Item.pairingId);

  // The code is the bearer key for either seat. Claiming ALWAYS re-mints the
  // seat's token (take-over): any previous device on this seat is invalidated
  // and will get a 403 on its next call.
  const wasFirstBClaim = seat === "B" && pairing.tokenB == null;
  const token = randomUUID();
  if (seat === "A") pairing.tokenA = token;
  else pairing.tokenB = token;
  pairing.updatedAt = Date.now();
  pairing.ttl = ttlEpoch();
  await ddb.send(new PutCommand({ TableName: TABLE, Item: pairing }));

  // Best-effort: tell A their opponent joined (only on the first B claim).
  if (wasFirstBClaim) {
    await pushTo(pairing, "A", {
      title: "Your opponent joined!",
      body: "They're making the first move.",
      url: "/",
    });
  }

  return {
    pairingId: pairing.pk.slice("PAIR#".length),
    code: pairing.code,
    role: seat,
    token,
    state: publicState(pairing),
  };
}

async function doGetState(body) {
  const pairing = await loadPairing(body.pairingId);
  assertToken(pairing, body.role, body.token);
  return { state: publicState(pairing) };
}

async function doEliminate(body) {
  const { pairingId, role, token, gameNumber, index } = body;
  const pairing = await loadPairing(pairingId);
  assertToken(pairing, role, token);

  if (gameNumber !== pairing.gameNumber) {
    throw new HttpError(409, "This game has moved on.", "STALE_GAME");
  }

  const updatedGame = applyElimination(pairing.game, role, index);
  pairing.game = updatedGame;
  pairing.updatedAt = Date.now();
  pairing.ttl = ttlEpoch();
  await ddb.send(new PutCommand({ TableName: TABLE, Item: pairing }));

  await notifyAfterMove(pairing);
  return { state: publicState(pairing) };
}

async function doRematch(body) {
  const { pairingId, role, token, choices } = body;
  const pairing = await loadPairing(pairingId);
  assertToken(pairing, role, token);

  if (role !== pairing.nextStarter) {
    throw new HttpError(409, "It's not your turn to start.", "NOT_YOUR_TURN_TO_START");
  }
  if (pairing.game.status !== "complete") {
    throw new HttpError(409, "Finish the current game first.", "GAME_IN_PROGRESS");
  }

  const number = pairing.gameNumber + 1;
  const game = createGame(choices, { startedBy: role, number });
  pairing.game = game;
  pairing.gameNumber = number;
  pairing.nextStarter = otherRole(role);
  pairing.updatedAt = Date.now();
  pairing.ttl = ttlEpoch();
  await ddb.send(new PutCommand({ TableName: TABLE, Item: pairing }));

  // Notify the OTHER player (who eliminates first) that a new game started.
  await pushTo(pairing, otherRole(role), {
    title: "New game started 🎲",
    body: `Player ${role} picked 4 new choices. Your move!`,
    url: "/",
  });

  return { state: publicState(pairing) };
}

async function doSubscribe(body) {
  const { pairingId, role, token, subscription } = body;
  const pairing = await loadPairing(pairingId);
  assertToken(pairing, role, token);
  if (!subscription?.endpoint) throw new HttpError(400, "Missing subscription");

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { pk: subPk(pairingId, role), subscription, ttl: ttlEpoch() },
    })
  );
  return { ok: true };
}

// --- Notifications ---

// After an elimination: if active, alert whoever's turn it is now; if complete,
// alert both players with the winner.
async function notifyAfterMove(pairing) {
  const game = pairing.game;
  if (game.status === "complete") {
    const winnerLabel = game.choices[game.winnerIndex];
    for (const role of ["A", "B"]) {
      await pushTo(pairing, role, {
        title: "Game over!",
        body: `Winner: ${winnerLabel}`,
        url: "/",
      });
    }
  } else {
    await pushTo(pairing, game.turn, {
      title: "Your turn!",
      body: "A choice was eliminated. Tap to make your move.",
      url: "/",
    });
  }
}

async function pushTo(pairing, role, payload) {
  const pairingId = pairing.pk.slice("PAIR#".length);
  const sub = await loadSub(pairingId, role);
  if (!sub) return;
  await sendPush(sub.subscription, payload);
}

// --- Helpers ---

async function loadPairing(id) {
  if (!id) throw new HttpError(400, "Missing pairingId");
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: pairPk(id) } })
  );
  if (!res.Item) throw new HttpError(404, "Pairing not found");
  return res.Item;
}

async function loadSub(pairingId, role) {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: subPk(pairingId, role) } })
  );
  return res.Item || null;
}

// Reserve a unique CODE -> pairingId mapping (retry on collision).
async function reserveUniqueCode(pairingId) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateCode();
    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: { pk: codePk(code), pairingId, ttl: ttlEpoch() },
          ConditionExpression: "attribute_not_exists(pk)",
        })
      );
      return code;
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException") continue;
      throw err;
    }
  }
  throw new HttpError(500, "Could not allocate a unique code");
}

function assertToken(pairing, role, token) {
  const expected =
    role === "A" ? pairing.tokenA : role === "B" ? pairing.tokenB : null;
  if (!expected || token !== expected) {
    throw new HttpError(403, "Invalid role token", "BAD_TOKEN");
  }
}

function normalizeCode(code) {
  if (typeof code !== "string") return null;
  const c = code.trim().toUpperCase();
  return c.length ? c : null;
}

// Strip secrets before returning to clients.
function publicState(pairing) {
  return {
    code: pairing.code,
    gameNumber: pairing.gameNumber,
    nextStarter: pairing.nextStarter,
    seatsClaimed: { A: pairing.tokenA != null, B: pairing.tokenB != null },
    bothJoined: pairing.tokenA != null && pairing.tokenB != null,
    game: {
      number: pairing.game.number,
      startedBy: pairing.game.startedBy,
      choices: pairing.game.choices,
      eliminated: pairing.game.eliminated,
      turn: pairing.game.turn,
      status: pairing.game.status,
      winnerIndex: pairing.game.winnerIndex,
    },
  };
}

// URL-friendly short id (n hex chars from uuids).
function shortId(n = 8) {
  let s = "";
  while (s.length < n) s += randomUUID().replace(/-/g, "");
  return s.slice(0, n);
}

function reply(status, payload) {
  // CORS owned solely by the Function URL config (template.yaml).
  return {
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
