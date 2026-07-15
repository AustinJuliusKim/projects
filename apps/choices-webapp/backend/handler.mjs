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
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  createGame,
  applyElimination,
  applyLinkClick,
  gameSummary,
  otherRole,
  GameError,
  LINK_PLATFORMS,
} from "./game.mjs";
import { applyCompletedGame, emptyStats, RECENT_GAMES_CAP } from "./stats.mjs";
import { applyGameToHistory, anonRecord, userHistoryEntries } from "./history.mjs";
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
import { isClean } from "./moderation.mjs";
import { emitCount, emitLatency } from "./metrics.mjs";
import { aggregateActive, isAdmin } from "./admin.mjs";
import { buildEvent, eventItem, EVENT_TYPES, CLIENT_EVENT_TYPES } from "./events.mjs";

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

  // Share-link preview page: GET /j/{code} (its own CloudFront behavior to
  // this origin). Crawlers never see the SPA — #/join fragments don't reach
  // any server — so the OG meta is rendered here; humans get an instant
  // client redirect into the unchanged join flow.
  if (method === "GET" && path.startsWith("/j/")) {
    try {
      return await ogPreviewPage(decodeURIComponent(path.slice("/j/".length)));
    } catch (err) {
      console.error("og preview error", err);
      return await ogPreviewPage(null);
    }
  }
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

  const startedAt = Date.now();
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
        return reply(200, await doRematch(body, user));
      case "subscribe":
        return reply(200, await doSubscribe(body));
      case "linkClick":
        return reply(200, await doLinkClick(body));
      case "track":
        return reply(200, await doTrack(body));
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
      case "getAdminOverview":
        return reply(200, await doGetAdminOverview(user));
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
    emitCount("ApiError", { action: String(body.action ?? "unknown") });
    return reply(500, { error: "Internal error" });
  } finally {
    // Per-action latency → EMF (Growth Plan §10 golden signals).
    emitLatency(String(body.action ?? "unknown"), Date.now() - startedAt);
  }
}

// --- Share-link preview (growth plan §8: OG previews) ---

// The page necessarily carries the code — it IS the invite link, no new
// exposure vs. today's #/join?code= links — but never tokens, and it rides
// a CachingDisabled behavior so per-code content can't cross-cache. A
// profane choice label downgrades the description to the generic line
// (moderation.mjs); the redirect works either way.
async function ogPreviewPage(rawCode) {
  const siteUrl = process.env.SITE_URL || "";
  const code = normalizeCode(rawCode);
  let choices = null;
  if (code) {
    const codeRes = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { pk: codePk(code) } })
    );
    if (codeRes.Item) {
      const pairRes = await ddb.send(
        new GetCommand({ TableName: TABLE, Key: { pk: pairPk(codeRes.Item.pairingId) } })
      );
      choices = pairRes.Item?.game?.choices ?? null;
    }
  }

  const description =
    choices && choices.every(isClean)
      ? `${choices.join(" vs ")} — cut wisely.`
      : "4 choices. 3 cuts. 1 winner.";
  // Relative redirect works on any stack; og:image needs an absolute URL,
  // so it only renders when SITE_URL is configured.
  const target = code && choices
    ? `/#/join?code=${encodeURIComponent(code)}`
    : "/#/join";
  const image = siteUrl
    ? `  <meta property="og:image" content="${siteUrl}og-card.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />\n`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>You've got Choices 😏</title>
  <meta property="og:type" content="website" />
  <meta property="og:title" content="You've got Choices 😏" />
  <meta property="og:description" content="${escapeHtml(description)}" />
${image}  <meta name="theme-color" content="#0f172a" />
  <script>location.replace(${JSON.stringify(target)});</script>
</head>
<body>
  <noscript><a href="${escapeHtml(target)}">Open your Choices invite</a></noscript>
</body>
</html>`;
  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body: html,
  };
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// --- Actions ---

// How the 4 choices were produced, for event payloads. Clients report
// "fill4" when the AI filled the form; anything else counts as manual.
function choiceSource(body) {
  return body.source === "fill4" ? "fill4" : "manual";
}

// Best-effort standalone event write for emitters with no pairing
// transaction to ride (push sends, Stripe webhooks, create-screen fills).
// Failures are logged, never surfaced — the lake is analytics, not the
// source of truth for any of these.
async function putEvent(type, fields) {
  try {
    await ddb.send(new PutCommand(eventItem(buildEvent(type, fields)).Put));
  } catch (err) {
    console.error("event write failed", type, err);
  }
}

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
  // Transactional outbox: the game_created event commits atomically with
  // the pairing (event-iff-write; the stream consumer forwards it to S3).
  const created = buildEvent("game_created", {
    pairingRef: pairingId,
    actorRole: "A",
    payload: { game_number: 1, choice_count: game.choices.length, source: choiceSource(body) },
  });
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [{ Put: { TableName: TABLE, Item: item } }, eventItem(created)],
    })
  );

  emitCount("GameCreated");
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
    const firstClaim = (seat === "A" ? pairing.tokenA : pairing.tokenB) == null;
    const wasFirstBClaim = seat === "B" && firstClaim;
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
    const claimed = buildEvent("seat_claimed", {
      pairingRef: pairing.pk.slice("PAIR#".length),
      actorRole: seat,
      payload: { seat, first_claim: firstClaim, signed_in: Boolean(user) },
    });
    try {
      await savePairing(pairing, [eventItem(claimed)]);
    } catch (err) {
      if (lostWriteRace(err) && attempt < 1) continue;
      throw err;
    }

    // Best-effort: tell A their opponent joined (only on the first B claim).
    if (wasFirstBClaim) {
      await pushTo(pairing, "A", {
        title: "They took the bait 😏",
        body: "Your opponent is in — they cut first.",
        url: "/",
      }, "joined");
    }

    emitCount("SeatClaimed");
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
    // pairing.game, so this is the only moment the record exists. Every cut
    // also rides its cut_made outbox event (event-iff-write).
    async (pairing) => [
      ...(await completionItems(pairing)),
      eventItem(
        buildEvent("cut_made", {
          pairingRef: pairing.pk.slice("PAIR#".length),
          actorRole: role,
          payload: {
            game_number: pairing.game.number,
            cut_number: pairing.game.eliminated.length,
            index,
          },
        })
      ),
    ]
  );

  if (!replay) {
    await notifyAfterMove(pairing);
    if (pairing.game.status === "complete") {
      emitCount("GameCompleted");
      await putAnonRecord(pairing);
    }
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

  // game_finished outbox event: attributed to whoever made the final cut.
  items.push(
    eventItem(
      buildEvent("game_finished", {
        pairingRef: pairingId,
        actorRole: summary.eliminated.at(-1).by,
        payload: {
          game_number: summary.number,
          winner_index: summary.winnerIndex,
          winner_label: summary.winnerLabel,
          choices: summary.choices,
          duration_ms: Math.max(0, summary.completedAt - summary.createdAt),
        },
      })
    )
  );
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

async function doRematch(body, user) {
  const { role, choices } = body;
  // Premium perk: a signed-in premium caller may start the next game out of
  // turn. Checked up front (one USER# read, signed-in callers only) because
  // the mutate callback must stay sync.
  const premiumBypass = user ? isPremium((await loadUser(user.sub)) ?? {}) : false;
  const { pairing, replay } = await mutatePairing(body, (pairing) => {
    if (role !== pairing.nextStarter && !premiumBypass) {
      throw new HttpError(409, "It's not your turn to start.", "NOT_YOUR_TURN_TO_START");
    }
    if (pairing.game.status !== "complete") {
      throw new HttpError(409, "Finish the current game first.", "GAME_IN_PROGRESS");
    }
    const number = pairing.gameNumber + 1;
    pairing.game = createGame(choices, { startedBy: role, number });
    pairing.gameNumber = number;
    pairing.nextStarter = otherRole(role);
  },
  (pairing) => [
    eventItem(
      buildEvent("rematch", {
        pairingRef: pairing.pk.slice("PAIR#".length),
        actorRole: role,
        payload: {
          game_number: pairing.gameNumber,
          choice_count: pairing.game.choices.length,
          source: choiceSource(body),
        },
      })
    ),
  ]);

  // Notify the OTHER player (who eliminates first) that a new game started.
  if (!replay) {
    await pushTo(pairing, otherRole(role), {
      title: "You've got new Choices 🎲",
      body: `Player ${role} picked 4 fresh ones. You cut first.`,
      url: "/",
    }, "rematch");
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
  await mutatePairing(
    body,
    (pairing) => {
      if (gameNumber !== pairing.gameNumber) {
        throw new HttpError(409, "This game has moved on.", "STALE_GAME");
      }
      pairing.game = applyLinkClick(pairing.game, role, platform);
    },
    (pairing) => linkClickEventItems(pairing, role, platform, body)
  );
  return { ok: true };
}

// Frozen-catalog mapping for outbound clicks: every click emits
// link_clicked; order platforms additionally emit order_click (funnel
// queries stay direct — catalog carries both), tips emit tip_given,
// reveal-card shares emit reveal_card_shared, and the created-screen
// premium tease is a paywall_viewed.
function linkClickEventItems(pairing, role, platform, body) {
  const pairingRef = pairing.pk.slice("PAIR#".length);
  const ev = (type, payload) =>
    eventItem(buildEvent(type, { pairingRef, actorRole: role, payload }));

  const items = [ev("link_clicked", { platform })];
  if (LINK_PLATFORMS.includes(platform)) {
    const placeId =
      typeof body.placeId === "string" && body.placeId.length > 0 && body.placeId.length <= 300
        ? body.placeId
        : undefined;
    items.push(ev("order_click", placeId ? { platform, place_id: placeId } : { platform }));
  }
  if (platform === "tip-venmo" || platform === "tip-stripe") {
    items.push(ev("tip_given", { platform }));
  }
  if (platform === "share-reveal") items.push(ev("reveal_card_shared", {}));
  if (platform === "premium-interest") {
    items.push(ev("paywall_viewed", { surface: "created-tease" }));
  }
  return items;
}

// Client-originated catalog events (the `track` action). The privacy gate:
// only types listed in CLIENT_EVENT_TYPES, only payloads their validators
// accept — enumerated strings and bounded ints, so typed text can never
// enter the lake from a client. Anything invalid is silently dropped with
// a 200 (analytics must never break a client). Pairing-scoped types
// require the seat token; join-flow types send the short code, which is
// resolved to a pairing_ref and DROPPED — the code never enters an event.
async function doTrack(body) {
  const scope = CLIENT_EVENT_TYPES[body.type];
  if (!scope) return { ok: true };
  const payload = body.payload ?? {};
  if (!EVENT_TYPES[body.type].validate(payload)) return { ok: true };

  let pairingRef = null;
  let actorRole = null;
  try {
    if (scope === "pairing" || (scope === "optional" && body.pairingId != null)) {
      const pairing = await loadPairing(body.pairingId);
      assertToken(pairing, body.role, body.token);
      pairingRef = pairing.pk.slice("PAIR#".length);
      actorRole = body.role;
    } else if (scope === "code") {
      const code = normalizeCode(body.code);
      if (!code) return { ok: true };
      const codeRes = await ddb.send(
        new GetCommand({ TableName: TABLE, Key: { pk: codePk(code) } })
      );
      if (!codeRes.Item) return { ok: true };
      pairingRef = codeRes.Item.pairingId;
    }
  } catch {
    return { ok: true }; // unknown pairing / bad token: drop, never 4xx a beacon
  }
  await putEvent(body.type, { pairingRef, actorRole, payload });
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
  const res = body.pairingId
    ? await fillForPairing(body, occasion)
    : await fillForUser(user, occasion);
  emitCount("FillMyFour");
  return res;
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
  await mutatePairing(
    body,
    (p) => {
      const u = p.ai?.month === month ? p.ai.uses : 0;
      if (!premium && u >= AI_FREE_USES) {
        throw new HttpError(409, AI_LIMIT_MSG, "AI_LIMIT");
      }
      p.ai = { month, uses: u + 1, lastResult: choices, usesLeft };
    },
    () => [
      eventItem(
        buildEvent("fill4_used", {
          pairingRef: pairingId,
          actorRole: role,
          payload: { context: "pairing", premium, uses_left: usesLeft },
        })
      ),
    ]
  );
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

  // The user's own recentGames seed the prompt — the create-screen
  // counterpart of the pairing path's HIST# memory (never crosses users).
  const choices = await fillFour({
    historyEntries: userHistoryEntries(item),
    occasion,
  });
  if (!choices) {
    throw new HttpError(502, "Couldn't fill your 4 — try again.", "AI_FAILED");
  }
  await bumpUserAiUses(user.sub, month);
  const usesLeft = premium ? null : AI_FREE_USES - uses - 1;
  // Create screen: no pairing exists yet, so the event stands alone
  // (actor "system" — there is no seat to attribute it to).
  await putEvent("fill4_used", {
    actorRole: "system",
    payload: { context: "create", premium, uses_left: usesLeft },
  });
  return { choices, usesLeft };
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

// --- Admin activity dashboard (owner-only, anonymous aggregates) ---

// Gate to the owner(s) in ADMIN_SUBS (comma-separated Cognito subs). Mirrors
// the SIGN_IN_REQUIRED guards; sub (stable) not email (mutable).
function assertAdmin(user) {
  if (!user) throw new HttpError(401, "Sign in required.", "SIGN_IN_REQUIRED");
  if (!isAdmin(user.sub, process.env.ADMIN_SUBS)) {
    throw new HttpError(403, "Forbidden.", "NOT_ADMIN");
  }
}

// The table has no GSI/stream, so the live set is read by a projected Scan
// (fine at current scale — PAY_PER_REQUEST + 30-day TTL bounds PAIR# items).
// Projection is limited to what the aggregate needs; tokens/code never leave.
async function scanActivePairings() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        ProjectionExpression: "pk, game, userA, userB",
        FilterExpression: "begins_with(pk, :p)",
        ExpressionAttributeValues: { ":p": "PAIR#" },
        ExclusiveStartKey,
      })
    );
    if (res.Items) items.push(...res.Items);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function doGetAdminOverview(user) {
  assertAdmin(user);
  const pairings = await scanActivePairings();
  return { ...aggregateActive(pairings), generatedAt: Date.now() };
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
  // Frozen-catalog mapping: sub_started only for checkout completions
  // (update.plan rides checkout-session metadata; recovery transitions to
  // "active" carry no plan and emit nothing), sub_cancelled for any
  // canceled status (subscription.deleted included). Never a user id.
  if (update.premium.status === "active" && ["monthly", "annual"].includes(update.plan)) {
    await putEvent("sub_started", { actorRole: "system", payload: { plan: update.plan } });
  } else if (update.premium.status === "canceled") {
    await putEvent("sub_cancelled", { actorRole: "system", payload: {} });
  }
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
        title: "Dinner's decided 🏆",
        body: `${winnerLabel} survived.`,
        url: "/",
      }, "winner");
    }
  } else {
    await pushTo(pairing, game.turn, {
      title: "Your move. Cut one. 😏",
      body: "A choice just got cut. You're up.",
      url: "/",
    }, "your_turn");
  }
}

async function pushTo(pairing, role, payload, trigger) {
  const pairingId = pairing.pk.slice("PAIR#".length);
  const sub = await loadSub(pairingId, role);
  if (!sub) return;
  const sent = await sendPush(sub.subscription, payload);
  // push_sent only records deliveries the push service accepted; the
  // best-effort put can never break the game action that triggered it.
  if (sent && trigger) {
    await putEvent("push_sent", {
      pairingRef: pairingId,
      actorRole: "system",
      payload: { trigger },
    });
  }
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
