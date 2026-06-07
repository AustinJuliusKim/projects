// Single Lambda (Function URL) for the elimination game.
// Routes by `action` in the JSON body: createGame | getGame | eliminate | subscribe.
import { randomUUID } from "node:crypto";
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  createGame,
  applyElimination,
  GameError,
} from "./game.mjs";
import { sendPush } from "./push.mjs";

const TABLE = process.env.TABLE_NAME;
const TTL_DAYS = 30;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const gamePk = (id) => `GAME#${id}`;
const subPk = (id, role) => `SUB#${id}#${role}`;
const ttlEpoch = () => Math.floor(Date.now() / 1000) + TTL_DAYS * 24 * 3600;

export async function handler(event) {
  // CORS preflight (Function URL CORS handles most, but be safe).
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
      case "createGame":
        return reply(200, await doCreate(body));
      case "getGame":
        return reply(200, await doGet(body));
      case "eliminate":
        return reply(200, await doEliminate(body));
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
      return reply(err.status, { error: err.message });
    }
    console.error("unhandled error", err);
    return reply(500, { error: "Internal error" });
  }
}

// --- Actions ---

async function doCreate(body) {
  const game = createGame(body.choices); // throws GameError on bad input
  const id = shortId();
  // Two secret tokens authorize each side. Creator holds tokenA; tokenB ships in the share link.
  const tokenA = randomUUID();
  const tokenB = randomUUID();

  const item = {
    pk: gamePk(id),
    ...game,
    tokenA,
    tokenB,
    ttl: ttlEpoch(),
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));

  return {
    game_id: id,
    role: "A",
    token: tokenA,
    inviteToken: tokenB, // embed in the share link for User B
    state: publicState(item),
  };
}

async function doGet(body) {
  const item = await loadGame(body.game_id);
  return { state: publicState(item) };
}

async function doEliminate(body) {
  const { game_id, role, token, index } = body;
  const item = await loadGame(game_id);
  assertToken(item, role, token);

  const updated = applyElimination(item, role, index); // throws GameError if invalid
  const next = { ...item, ...updated };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: next }));

  // Notify the other player it's their turn (or that the game finished). Best-effort.
  await notify(game_id, next);

  return { state: publicState(next) };
}

async function doSubscribe(body) {
  const { game_id, role, token, subscription } = body;
  const item = await loadGame(game_id);
  assertToken(item, role, token);
  if (!subscription?.endpoint) {
    throw new HttpError(400, "Missing subscription");
  }
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: subPk(game_id, role),
        subscription,
        ttl: ttlEpoch(),
      },
    })
  );
  return { ok: true };
}

// --- Helpers ---

async function loadGame(id) {
  if (!id) throw new HttpError(400, "Missing game_id");
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: gamePk(id) } })
  );
  if (!res.Item) throw new HttpError(404, "Game not found");
  return res.Item;
}

function assertToken(item, role, token) {
  const expected = role === "A" ? item.tokenA : role === "B" ? item.tokenB : null;
  if (!expected || token !== expected) {
    throw new HttpError(403, "Invalid role token");
  }
}

async function notify(gameId, game) {
  // After a move, alert the player whose turn it now is.
  // If complete, alert BOTH players of the winner.
  const targets =
    game.status === "complete" ? ["A", "B"] : [game.turn];

  const winnerLabel =
    game.winnerIndex != null ? game.choices[game.winnerIndex] : null;

  for (const role of targets) {
    const sub = await loadSub(gameId, role);
    if (!sub) continue;
    const payload =
      game.status === "complete"
        ? {
            title: "Game over!",
            body: `Winner: ${winnerLabel}`,
            url: `/g/${gameId}`,
          }
        : {
            title: "Your turn!",
            body: "A choice was eliminated. Tap to make your move.",
            url: `/g/${gameId}`,
          };
    await sendPush(sub.subscription, payload);
  }
}

async function loadSub(gameId, role) {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: subPk(gameId, role) } })
  );
  return res.Item || null;
}

// Strip secrets before returning to clients.
function publicState(item) {
  return {
    choices: item.choices,
    eliminated: item.eliminated,
    turn: item.turn,
    status: item.status,
    winnerIndex: item.winnerIndex,
  };
}

// URL-friendly short id (8 chars from a uuid).
function shortId() {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

function reply(status, payload) {
  // CORS headers are owned solely by the Function URL CORS config (template.yaml)
  // to avoid emitting duplicate Access-Control-Allow-Origin headers, which
  // browsers reject.
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json",
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
