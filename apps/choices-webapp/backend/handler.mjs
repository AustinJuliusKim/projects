// Single Lambda (Function URL) for the elimination game.
//
// Model: a persistent A<->B PAIRING hosts a series of games. Identity (tokenA/
// tokenB) and push subscriptions live at the pairing level so they survive
// rematches. B joins by entering a short human CODE inside the app.
//
// Actions: createPairing | claimSeat | getState | eliminate | rematch |
// subscribe | linkClick | getMe | createCheckoutSession | createPortalSession
// | getPairHistory | placesSuggest | placeDetails | fillMyFour
// (+ POST /api/stripe-webhook, routed by path, raw-body signature verified)
//
// Accounts are optional: a Cognito ID token in the authorization header
// links seats to a user (history/streaks); its absence means guest.
import { createHmac, randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  createGame,
  applyElimination,
  applyLinkClick,
  gameSummary,
  otherRole,
  GameError,
} from "./game.mjs";
import { applyCompletedGame, emptyStats, RECENT_GAMES_CAP } from "./stats.mjs";
import { applyGameToHistory, anonRecord } from "./history.mjs";
import { verifyIdToken, AuthError } from "./auth.mjs";
import {
  billingEnabled,
  createCheckoutSession,
  createPortalSession,
  parseWebhook,
  BillingError,
} from "./billing.mjs";
import { sendPush } from "./push.mjs";
import { autocomplete, details, placesEnabled } from "./places.mjs";
import { aiEnabled, fillFour } from "./suggestai.mjs";

const TABLE = process.env.TABLE_NAME;
const TTL_DAYS = 30;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const pairPk = (id) => `PAIR#${id}`;
const codePk = (code) => `CODE#${code}`;
const subPk = (pairingId, role) => `SUB#${pairingId}#${role}`;
const gamePk = (pairingId, number) => `GAME#${pairingId}#${number}`;
const userPk = (userId) => `USER#${userId}`;
const histPk = (pairingId) => `HIST#${pairingId}`;
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

// When enforced, only requests carrying the CloudFront origin secret are
// served — direct Function URL calls get a 403. Enabled (via env) only after
// the frontend has switched to the CloudFront /api path.
function originAllowed(event) {
  if (process.env.ENFORCE_ORIGIN_HEADER !== "true") return true;
  return event?.headers?.["x-origin-verify"] === process.env.ORIGIN_VERIFY_SECRET;
}

// getState replies: never cached — the /api* behavior uses the managed
// CachingDisabled policy (see template.yaml for why), and browsers must
// always revalidate. publicState still must never carry credentials, so a
// future caching-enabled policy stays safe to introduce.
const GETSTATE_HEADERS = { "cache-control": "no-cache" };

export async function handler(event) {
  const method = event?.requestContext?.http?.method;
  if (method === "OPTIONS") return reply(204, "");
  if (!originAllowed(event)) return reply(403, { error: "Forbidden" });

  // Stripe webhook: routed by path (Stripe posts to a fixed URL, not our
  // action envelope) and verified against the RAW body before any parsing.
  const path = event?.rawPath ?? event?.requestContext?.http?.path ?? "";
  if (method === "POST" && path.endsWith("/stripe-webhook")) {
    try {
      return reply(200, await doStripeWebhook(event));
    } catch (err) {
      if (err instanceof BillingError) {
        return reply(err.status, { error: err.message, code: err.code });
      }
      console.error("webhook error", err);
      return reply(500, { error: "Internal error" });
    }
  }

  let body;
  if (method === "GET") {
    // Cacheable read path: CloudFront only caches GET, so getState is also
    // exposed as GET /?action=getState&pairingId=..&role=..&token=..
    body = { ...(event.queryStringParameters || {}) };
    if (body.action !== "getState") return reply(400, { error: "Unknown action" });
  } else {
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return reply(400, { error: "Invalid JSON" });
    }
  }

  try {
    // Optional account identity: guests send no header; a bad token is a hard
    // 401 (never downgraded to guest — broken clients must not corrupt links).
    const user = await verifyIdToken(event?.headers?.authorization);

    switch (body.action) {
      case "createPairing":
        return reply(200, await doCreatePairing(body));
      case "claimSeat":
        return reply(200, await doClaimSeat(body, user));
      case "getState":
        return reply(200, await doGetState(body), GETSTATE_HEADERS);
      case "eliminate":
        return reply(200, await doEliminate(body));
      case "rematch":
        return reply(200, await doRematch(body));
      case "subscribe":
        return reply(200, await doSubscribe(body));
      case "linkClick":
        return reply(200, await doLinkClick(body));
      case "getPairHistory":
        return reply(200, await doGetPairHistory(body));
      case "placesSuggest":
        return reply(200, await doPlacesSuggest(body));
      case "placeDetails":
        return reply(200, await doPlaceDetails(body));
      case "fillMyFour":
        return reply(200, await doFillMyFour(body, user));
      case "getMe":
        return reply(200, await doGetMe(user));
      case "createCheckoutSession":
        return reply(200, await doCreateCheckoutSession(user, body));
      case "createPortalSession":
        return reply(200, await doCreatePortalSession(user));
      default:
        return reply(400, { error: "Unknown action" });
    }
  } catch (err) {
    if (err instanceof AuthError) {
      return reply(401, { error: err.message, code: err.code });
    }
    if (err instanceof BillingError) {
      return reply(err.status, { error: err.message, code: err.code });
    }
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
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ttl: ttlEpoch(),
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));

  return { pairingId, code, state: publicState(item) };
}

async function doClaimSeat(body, user) {
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

  // The code is the bearer key for either seat. Claiming ALWAYS re-mints the
  // seat's token (take-over): any previous device on this seat is invalidated
  // and will get a 403 on its next call.
  for (let attempt = 0; ; attempt++) {
    const pairing = await loadPairing(codeRes.Item.pairingId);
    const wasFirstBClaim = seat === "B" && pairing.tokenB == null;
    const token = randomUUID();
    // Claiming defines the seat's identity: a signed-in claim links the seat
    // to the account; an anonymous claim (incl. takeover) unlinks it so a
    // previous user never accrues someone else's games.
    if (seat === "A") {
      pairing.tokenA = token;
      pairing.userA = user?.sub ?? null;
    } else {
      pairing.tokenB = token;
      pairing.userB = user?.sub ?? null;
    }
    pairing.updatedAt = Date.now();
    pairing.ttl = ttlEpoch();
    try {
      await savePairing(pairing);
    } catch (err) {
      if (err?.name === "ConditionalCheckFailedException" && attempt < 1) continue;
      throw err;
    }

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
}

async function doGetState(body) {
  const pairing = await loadPairing(body.pairingId);
  assertToken(pairing, body.role, body.token);
  return { state: publicState(pairing) };
}

async function doEliminate(body) {
  const { role, gameNumber, index } = body;
  const { pairing, replay } = await mutatePairing(
    body,
    (pairing) => {
      if (gameNumber !== pairing.gameNumber) {
        throw new HttpError(409, "This game has moved on.", "STALE_GAME");
      }
      pairing.game = applyElimination(pairing.game, role, index);
    },
    // The winning move archives the game and folds it into each signed-in
    // player's stats, all in the same transaction — rematch overwrites
    // pairing.game, so this is the only moment the record exists.
    completionItems
  );

  if (!replay) {
    await notifyAfterMove(pairing);
    if (pairing.game.status === "complete") await putAnonRecord(pairing);
  }
  return { state: publicState(pairing) };
}

// Anonymized global-suggestions feed (suggestion engine Phase 0): one small
// S3 object per finished game, daily-partitioned for the future nightly
// batch. The keyed pairHash (salt only in this env) lets Phase 2 apply the
// k-anonymity floor without the store ever holding pairing ids. Best-effort:
// failures are logged, never surfaced to the move that won the game.
async function putAnonRecord(pairing) {
  const bucket = process.env.SUGGEST_BUCKET;
  const salt = process.env.ANON_SALT;
  if (!bucket || !salt) return;
  try {
    const summary = gameSummary(pairing.game);
    const pairingId = pairing.pk.slice("PAIR#".length);
    const pairHash = createHmac("sha256", salt)
      .update(pairingId)
      .digest("hex")
      .slice(0, 16);
    const record = anonRecord(summary, pairHash);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `entries/dt=${record.day}/${Date.now()}-${randomUUID()}.json`,
        Body: JSON.stringify(record),
        ContentType: "application/json",
      })
    );
  } catch (err) {
    console.error("anon record write failed", err);
  }
}

// Extra transact items for a completing move: the GAME# archive, a
// stats/recentGames fold into USER# for each seat linked to an account, and
// the HIST# pair-memory fold (suggestion engine L1).
async function completionItems(pairing) {
  if (pairing.game.status !== "complete") return [];
  const summary = gameSummary(pairing.game);
  const pairingId = pairing.pk.slice("PAIR#".length);
  const items = [archivePut(pairing, pairingId, summary)];

  const rec = {
    pairingId,
    number: summary.number,
    winnerLabel: summary.winnerLabel,
    choices: summary.choices,
    completedAt: summary.completedAt,
  };
  // A user can hold both seats (two devices); count the game once.
  const userIds = [...new Set([pairing.userA, pairing.userB].filter(Boolean))];
  for (const userId of userIds) {
    const user = (await loadUser(userId)) ?? emptyUser(userId);
    items.push(versionedPut(applyCompletedGame(user, rec)));
  }

  // HIST# refreshes its ttl only here, and completions are what keep a
  // pairing alive — so pair memory expires no later than the pairing itself
  // (privacy: pair history dies with the pair).
  const hist = (await loadHist(pairingId)) ?? emptyHist(pairingId);
  items.push(versionedPut({ ...applyGameToHistory(hist, summary), ttl: ttlEpoch() }));
  return items;
}

// GAME# archive item for a just-completed game (history/streaks source of
// truth). Unconditional put: a lost-race retry rewrites identical content.
// Guest-only games age out with the standard TTL; games with a signed-in
// participant are kept (future premium full-history reads from these).
function archivePut(pairing, pairingId, summary) {
  const players = { A: pairing.userA ?? null, B: pairing.userB ?? null };
  const item = {
    pk: gamePk(pairingId, summary.number),
    pairingId,
    ...summary,
    players,
  };
  if (!players.A && !players.B) item.ttl = ttlEpoch();
  return { Put: { TableName: TABLE, Item: item } };
}

async function doRematch(body) {
  const { role, choices } = body;
  const { pairing, replay } = await mutatePairing(body, (pairing) => {
    if (role !== pairing.nextStarter) {
      throw new HttpError(409, "It's not your turn to start.", "NOT_YOUR_TURN_TO_START");
    }
    if (pairing.game.status !== "complete") {
      throw new HttpError(409, "Finish the current game first.", "GAME_IN_PROGRESS");
    }
    const number = pairing.gameNumber + 1;
    pairing.game = createGame(choices, { startedBy: role, number });
    pairing.gameNumber = number;
    pairing.nextStarter = otherRole(role);
  });

  // Notify the OTHER player (who eliminates first) that a new game started.
  if (!replay) {
    await pushTo(pairing, otherRole(role), {
      title: "New game started 🎲",
      body: `Player ${role} picked 4 new choices. Your move!`,
      url: "/",
    });
  }

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

// Record an outbound order-link click on the current game (conversion-funnel
// data: games completed -> winner screens -> order clicks).
async function doLinkClick(body) {
  const { role, gameNumber, platform } = body;
  await mutatePairing(body, (pairing) => {
    if (gameNumber !== pairing.gameNumber) {
      throw new HttpError(409, "This game has moved on.", "STALE_GAME");
    }
    pairing.game = applyLinkClick(pairing.game, role, platform);
  });
  return { ok: true };
}

// --- Suggestions (typeahead, suggestion engine Phase 1) ---

// L1 pair memory for the rematch form. Seat-token-authed; called once per
// session by the client, never on the poll path.
async function doGetPairHistory(body) {
  const pairing = await loadPairing(body.pairingId);
  assertToken(pairing, body.role, body.token);
  const hist = await loadHist(body.pairingId);
  return { entries: Object.values(hist?.entries ?? {}) };
}

// L3 Places proxy. Unauthenticated by design — the create screen has no
// pairing yet. Backstops: WAF per-IP rate cap, input validation here, and a
// Places-API-restricted key that can be pulled (blanked) at any time.
async function doPlacesSuggest(body) {
  const input = typeof body.input === "string" ? body.input.trim() : "";
  if (input.length < 2 || input.length > 60) {
    return { suggestions: [], enabled: placesEnabled() };
  }
  // Location comes from browser geolocation in the body (the 📍 pin is the
  // consent surface) — CloudFront's geo headers were rejected by prod's
  // pricing plan (see template.yaml). No coords -> neutral world-rect bias,
  // never the Lambda's own IP location.
  return autocomplete(input, sessionToken(body), clientGeo(body));
}

// Validated {latitude, longitude} from the request body, or null. Used only
// to bias the Places query upstream — never stored, never returned (privacy
// posture; the client rounds before sending).
function clientGeo(body) {
  const { latitude, longitude } = body.geo ?? {};
  if (typeof latitude !== "number" || typeof longitude !== "number") return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

async function doPlaceDetails(body) {
  const { placeId } = body;
  if (typeof placeId !== "string" || !placeId || placeId.length > 300) {
    throw new HttpError(400, "Missing placeId");
  }
  return details(placeId, sessionToken(body));
}

// Client-generated per-focus token forwarded verbatim (Places session
// billing); anything oversized or non-string is dropped, never rejected.
function sessionToken(body) {
  const t = body.sessionToken;
  return typeof t === "string" && t.length > 0 && t.length <= 64 ? t : undefined;
}

// --- "Fill my 4" (suggestion engine Phase 3) ---
//
// One Bedrock call per use, gated at AI_FREE_USES per calendar month
// (premium = unlimited). Two contexts:
//  - rematch (pairingId present): counter on the pairing item, premium if
//    either linked seat's account is premium. Idempotent via actionId.
//  - create screen (no pairing exists yet, so "counter on the pairing" is
//    impossible there): requires sign-in; counter on the USER# item. The
//    join flow and manual creation stay untouched and free.
const AI_FREE_USES = 3;
const utcMonth = () => new Date().toISOString().slice(0, 7);
const AI_LIMIT_MSG = "You're out of free fills this month. Premium never runs out. 😏";

async function doFillMyFour(body, user) {
  if (!aiEnabled()) {
    throw new HttpError(400, "AI fills are not enabled here.", "AI_DISABLED");
  }
  const occasion =
    typeof body.occasion === "string" ? body.occasion.trim().slice(0, 40) : "";
  if (body.pairingId) return fillForPairing(body, occasion);
  return fillForUser(user, occasion);
}

async function fillForPairing(body, occasion) {
  const { pairingId, role, token, actionId } = body;
  const pairing = await loadPairing(pairingId);
  assertToken(pairing, role, token);
  // Replay of a landed fill: return the stored result, no second Bedrock
  // call (mirrors mutatePairing's replay contract).
  if (actionId && pairing.lastActionId === actionId && pairing.ai?.lastResult) {
    return { choices: pairing.ai.lastResult, usesLeft: pairing.ai.usesLeft ?? null };
  }

  const month = utcMonth();
  const uses = pairing.ai?.month === month ? pairing.ai.uses : 0;
  const premium = await pairingHasPremium(pairing);
  if (!premium && uses >= AI_FREE_USES) {
    throw new HttpError(409, AI_LIMIT_MSG, "AI_LIMIT");
  }

  const hist = await loadHist(pairingId);
  const choices = await fillFour({
    historyEntries: Object.values(hist?.entries ?? {}),
    occasion,
  });
  if (!choices) {
    throw new HttpError(502, "Couldn't fill your 4 — try again.", "AI_FAILED");
  }

  const usesLeft = premium ? null : AI_FREE_USES - uses - 1;
  await mutatePairing(body, (p) => {
    const u = p.ai?.month === month ? p.ai.uses : 0;
    if (!premium && u >= AI_FREE_USES) {
      throw new HttpError(409, AI_LIMIT_MSG, "AI_LIMIT");
    }
    p.ai = { month, uses: u + 1, lastResult: choices, usesLeft };
  });
  return { choices, usesLeft };
}

async function fillForUser(user, occasion) {
  if (!user) {
    throw new HttpError(401, "Sign in to fill your 4.", "SIGN_IN_REQUIRED");
  }
  const item = await ensureUser(user);
  const premium = isPremium(item);
  const month = utcMonth();
  const uses = item.aiUses?.month === month ? item.aiUses.uses : 0;
  if (!premium && uses >= AI_FREE_USES) {
    throw new HttpError(409, AI_LIMIT_MSG, "AI_LIMIT");
  }

  const choices = await fillFour({ occasion });
  if (!choices) {
    throw new HttpError(502, "Couldn't fill your 4 — try again.", "AI_FAILED");
  }
  await bumpUserAiUses(user.sub, month);
  return { choices, usesLeft: premium ? null : AI_FREE_USES - uses - 1 };
}

async function pairingHasPremium(pairing) {
  const userIds = [...new Set([pairing.userA, pairing.userB].filter(Boolean))];
  for (const userId of userIds) {
    const u = await loadUser(userId);
    if (u && isPremium(u)) return true;
  }
  return false;
}

// Same optimistic-lock loop shape as updateUserPremium.
async function bumpUserAiUses(userId, month) {
  for (let attempt = 0; ; attempt++) {
    const u = (await loadUser(userId)) ?? emptyUser(userId);
    const uses = u.aiUses?.month === month ? u.aiUses.uses : 0;
    u.aiUses = { month, uses: uses + 1 };
    u.updatedAt = Date.now();
    try {
      await ddb.send(new PutCommand(versionedPut(u).Put));
      return;
    } catch (err) {
      if (err?.name !== "ConditionalCheckFailedException" || attempt >= 1) throw err;
    }
  }
}

// Account profile + gated stats/history. Free accounts see games played and
// the 10 most recent games; streaks and choice win counts (topWinners) are
// premium-gated at the API so the client can't peek. streakLocked/
// historyLocked are the upsell teaser flags.
const FREE_RECENT_GAMES = 10;

function isPremium(item) {
  return ["active", "past_due"].includes(item.premium?.status);
}

async function doGetMe(user) {
  if (!user) throw new HttpError(401, "Sign in required.", "SIGN_IN_REQUIRED");
  const item = await ensureUser(user);
  const premium = isPremium(item);
  const recentGames = item.recentGames ?? [];
  const stats = item.stats ?? emptyStats();
  return {
    profile: {
      userId: item.userId,
      email: item.email ?? user.email,
      name: item.name ?? user.name,
    },
    premium: item.premium ?? { status: "none" },
    stats: premium
      ? {
          gamesPlayed: stats.gamesPlayed,
          currentStreak: stats.currentStreak,
          bestStreak: stats.bestStreak,
          lastPlayedDay: stats.lastPlayedDay,
          topWinners: stats.topWinners,
        }
      : { gamesPlayed: stats.gamesPlayed, streakLocked: true },
    recentGames: recentGames.slice(0, premium ? RECENT_GAMES_CAP : FREE_RECENT_GAMES),
    historyLocked: !premium && recentGames.length > FREE_RECENT_GAMES,
    billingAvailable: billingEnabled(),
  };
}

// Load the USER# item, persisting the skeleton on first visit so billing
// (Stripe customer id) has a row to attach to. Lost creation races fall
// through to a reload.
async function ensureUser(user) {
  let item = await loadUser(user.sub);
  if (item) return item;
  item = { ...emptyUser(user.sub), email: user.email, name: user.name };
  try {
    await ddb.send(new PutCommand(versionedPut(item).Put));
    item.version = 1;
  } catch (err) {
    if (err?.name !== "ConditionalCheckFailedException") throw err;
    item = await loadUser(user.sub);
  }
  return item;
}

// --- Billing (premium subscription) ---

async function doCreateCheckoutSession(user, body) {
  if (!user) throw new HttpError(401, "Sign in required.", "SIGN_IN_REQUIRED");
  if (!billingEnabled()) {
    throw new HttpError(400, "Billing is not enabled here.", "BILLING_DISABLED");
  }
  const item = await ensureUser(user);
  const { url, customerId } = await createCheckoutSession(
    item,
    body.plan,
    process.env.SITE_URL
  );
  // Persist a newly-minted customer id before redirecting; webhooks for
  // subscription events resolve the user via metadata either way.
  if (item.premium?.stripeCustomerId !== customerId) {
    await updateUserPremium(user.sub, { stripeCustomerId: customerId });
  }
  return { url };
}

async function doCreatePortalSession(user) {
  if (!user) throw new HttpError(401, "Sign in required.", "SIGN_IN_REQUIRED");
  if (!billingEnabled()) {
    throw new HttpError(400, "Billing is not enabled here.", "BILLING_DISABLED");
  }
  const item = await ensureUser(user);
  return createPortalSession(item, process.env.SITE_URL);
}

async function doStripeWebhook(event) {
  if (!billingEnabled()) {
    throw new HttpError(400, "Billing is not enabled here.", "BILLING_DISABLED");
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";
  const update = parseWebhook(raw, event.headers?.["stripe-signature"]);
  // Unhandled event types or events missing our metadata: acknowledge so
  // Stripe stops retrying — there's nothing to apply.
  if (!update?.userId) return { ok: true };
  await updateUserPremium(update.userId, update.premium);
  return { ok: true };
}

// Merge premium fields onto the USER# item with the usual version condition
// (retried once — webhooks can race game completions).
async function updateUserPremium(userId, premium) {
  for (let attempt = 0; ; attempt++) {
    const user = (await loadUser(userId)) ?? emptyUser(userId);
    user.premium = { ...user.premium, ...premium };
    user.updatedAt = Date.now();
    try {
      await ddb.send(new PutCommand(versionedPut(user).Put));
      return;
    } catch (err) {
      if (err?.name !== "ConditionalCheckFailedException" || attempt >= 1) throw err;
    }
  }
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

// Optimistic-lock write: succeeds only if the stored item still carries the
// version we loaded (legacy items predating `version` age out via TTL and are
// matched by attribute_not_exists). Bumps version on success. Extra transact
// items (e.g. the GAME# archive) commit atomically with the pairing — the
// pairing put is always TransactItems[0], so cancellation reason 0 is the
// version check.
async function savePairing(pairing, extraItems = []) {
  const expected = pairing.version;
  pairing.version = (expected ?? 0) + 1;
  const put = { TableName: TABLE, Item: pairing };
  if (expected == null) {
    put.ConditionExpression = "attribute_not_exists(version)";
  } else {
    put.ConditionExpression = "version = :v";
    put.ExpressionAttributeValues = { ":v": expected };
  }
  if (extraItems.length === 0) {
    await ddb.send(new PutCommand(put));
    return;
  }
  await ddb.send(
    new TransactWriteCommand({ TransactItems: [{ Put: put }, ...extraItems] })
  );
}

// Load-mutate-save a pairing with optimistic locking and actionId replay
// detection. `mutate(pairing)` applies the change in place (throws on
// invalid input). Retried client requests reuse their actionId, so a
// duplicate that already landed returns { replay: true } with the stored
// state instead of failing — callers skip side effects (push) on replay.
async function mutatePairing({ pairingId, role, token, actionId }, mutate, extraItemsFn) {
  for (let attempt = 0; ; attempt++) {
    const pairing = await loadPairing(pairingId);
    assertToken(pairing, role, token);
    if (actionId && pairing.lastActionId === actionId) {
      return { pairing, replay: true };
    }
    mutate(pairing);
    if (actionId) pairing.lastActionId = actionId;
    pairing.updatedAt = Date.now();
    pairing.ttl = ttlEpoch();
    try {
      await savePairing(pairing, extraItemsFn ? await extraItemsFn(pairing) : []);
      return { pairing, replay: false };
    } catch (err) {
      if (!lostWriteRace(err)) throw err;
      if (attempt >= 1) {
        throw new HttpError(409, "Conflicting update, try again.", "WRITE_CONFLICT");
      }
      // Lost a write race — reload and re-apply (replay check runs again).
    }
  }
}

// A version condition can fail two ways: plain put -> Conditional-
// CheckFailedException; transactional put -> TransactionCanceledException
// with that item's reason set to ConditionalCheckFailed (the pairing's
// version at index 0, or a USER# version raced by a concurrent completion).
// Either way the fix is the same: reload everything and re-apply.
function lostWriteRace(err) {
  if (err?.name === "ConditionalCheckFailedException") return true;
  return (
    err?.name === "TransactionCanceledException" &&
    (err.CancellationReasons ?? []).some(
      (r) => r?.Code === "ConditionalCheckFailed"
    )
  );
}

async function loadPairing(id) {
  if (!id) throw new HttpError(400, "Missing pairingId");
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: pairPk(id) } })
  );
  if (!res.Item) throw new HttpError(404, "Pairing not found");
  return res.Item;
}

async function loadUser(userId) {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: userPk(userId) } })
  );
  return res.Item || null;
}

async function loadHist(pairingId) {
  const res = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { pk: histPk(pairingId) } })
  );
  return res.Item || null;
}

function emptyHist(pairingId) {
  return { pk: histPk(pairingId), pairingId, entries: {}, createdAt: Date.now() };
}

// USER# items never expire (no ttl) — they're the account's durable record.
function emptyUser(userId, now = Date.now()) {
  return {
    pk: userPk(userId),
    userId,
    createdAt: now,
    updatedAt: now,
    stats: emptyStats(),
    recentGames: [],
    premium: { status: "none" },
  };
}

// Version-conditioned put for USER#/HIST# items (same optimistic-lock shape
// as savePairing); used standalone and inside the completion transaction.
function versionedPut(item) {
  const expected = item.version;
  const put = { TableName: TABLE, Item: { ...item, version: (expected ?? 0) + 1 } };
  if (expected == null) {
    put.ConditionExpression = "attribute_not_exists(version)";
  } else {
    put.ConditionExpression = "version = :v";
    put.ExpressionAttributeValues = { ":v": expected };
  }
  return { Put: put };
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

// Strip secrets before returning to clients. Deliberately excludes `code`:
// getState responses are edge-cached keyed by pairingId (token validation is
// skipped on a cache hit), and the code is the bearer key for seat takeover
// via claimSeat — it must never ride in a cacheable body. Clients get the
// code from createPairing/claimSeat responses and persist it locally.
// Scrutinize any field added here with the same lens.
function publicState(pairing) {
  return {
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

function reply(status, payload, extraHeaders) {
  // CORS owned solely by the Function URL config (template.yaml).
  return {
    statusCode: status,
    headers: { "content-type": "application/json", ...extraHeaders },
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
