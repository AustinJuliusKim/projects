// The planner board: a map plus ordered steps ("Setup", "Execute", ...), each
// holding drawn items in board units (0..1000 over the minimap image). All
// edits go through `reduce`, and `history` wraps it for undo/redo. Items
// store agent ids, never image URLs, so a shared board can't inject content.
import { BOARD_SIZE, fanOut } from "./geometry.js";

// The drawing palette doubles as the share-link allowlist, so role colors
// (used for plan arrows) must come from it.
export const COLORS = ["#ece8e1", "#ff6b6b", "#2dd4bf", "#fbbf24", "#a78bfa", "#60a5fa"];
export const ROLE_HEX = { Duelist: COLORS[1], Controller: COLORS[4], Initiator: COLORS[2], Sentinel: COLORS[3] };
export const TEAMS = ["ally", "enemy"];
export const MAX_STEPS = 12;
export const MAX_ITEMS = 400; // per step
const MAX_POINTS = 600; // per path
const MAX_TEXT = 120;

export function blankBoard(mapId) {
  return { v: 1, map: mapId, nextId: 1, steps: [{ name: "Setup", items: [] }] };
}

const r1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const coord = (n) => r1(clamp(Number(n) || 0, -200, BOARD_SIZE + 200));

function withStep(board, stepIndex, fn) {
  const steps = board.steps.map((s, i) => (i === stepIndex ? { ...s, items: fn(s.items) } : s));
  return { ...board, steps };
}

function moveItem(item, dx, dy) {
  if (item.type === "path") {
    return { ...item, points: item.points.map(([x, y]) => [coord(x + dx), coord(y + dy)]) };
  }
  return { ...item, x: coord(item.x + dx), y: coord(item.y + dy) };
}

// Pure board transitions. Unknown actions and out-of-range steps return the
// board unchanged (same reference), which `history` treats as a no-op.
export function reduce(board, action) {
  const step = action.step ?? 0;
  if (step < 0 || step >= board.steps.length) return board;
  switch (action.type) {
    case "add": {
      if (board.steps[step].items.length >= MAX_ITEMS) return board;
      const item = { ...action.item, id: `i${board.nextId}` };
      return { ...withStep(board, step, (items) => [...items, item]), nextId: board.nextId + 1 };
    }
    case "update":
      return withStep(board, step, (items) =>
        items.map((it) => (it.id === action.id ? { ...it, ...action.patch, id: it.id, type: it.type } : it)));
    case "move":
      if (!action.dx && !action.dy) return board;
      return withStep(board, step, (items) =>
        items.map((it) => (it.id === action.id ? moveItem(it, action.dx, action.dy) : it)));
    case "remove":
      return withStep(board, step, (items) => items.filter((it) => it.id !== action.id));
    case "clear":
      if (!board.steps[step].items.length) return board;
      return withStep(board, step, () => []);
    case "addStep": {
      if (board.steps.length >= MAX_STEPS) return board;
      // New steps start as a copy of the current one, ValoPlant-style, so
      // the next phase only needs the changes drawn.
      const copy = { name: `Step ${board.steps.length + 1}`, items: board.steps[step].items };
      const steps = [...board.steps.slice(0, step + 1), copy, ...board.steps.slice(step + 1)];
      return { ...board, steps };
    }
    case "removeStep":
      if (board.steps.length === 1) return board;
      return { ...board, steps: board.steps.filter((_, i) => i !== step) };
    case "renameStep":
      return { ...board, steps: board.steps.map((s, i) => (i === step ? { ...s, name: String(action.name).slice(0, 40) } : s)) };
    case "setMap":
      return action.map === board.map ? board : blankBoard(action.map);
    default:
      return board;
  }
}

export function createHistory(board) {
  return { past: [], present: board, future: [] };
}

const HISTORY_LIMIT = 100;

export function history(h, action) {
  if (action.type === "undo") {
    if (!h.past.length) return h;
    return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
  }
  if (action.type === "redo") {
    if (!h.future.length) return h;
    return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
  }
  if (action.type === "reset") return createHistory(action.board);
  const next = reduce(h.present, action);
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}

// Turns a generated plan into an editable board: players where the plan put
// them, their utility at its target, and an arrow for each assignment.
export function fromPlan(plan) {
  let board = blankBoard(plan.mapId);
  const add = (item) => { board = reduce(board, { type: "add", item }); };
  const spots = fanOut(plan.players, 30);
  plan.players.forEach((p, i) => {
    const from = spots[i];
    if (p.target && p.target.name !== p.at.name) {
      const to = { x: p.target.x * BOARD_SIZE, y: p.target.y * BOARD_SIZE };
      add({ type: "path", points: [[r1(from.x), r1(from.y)], [r1(to.x), r1(to.y)]], color: ROLE_HEX[p.role] ?? COLORS[0], arrow: true });
      if (p.ability) add({ type: "ability", agentId: p.agentId, slot: p.ability.slot, team: "ally", x: r1(to.x), y: r1(to.y) });
    }
  });
  plan.players.forEach((p, i) => {
    add({ type: "agent", agentId: p.agentId, team: "ally", x: r1(spots[i].x), y: r1(spots[i].y) });
  });
  return reduce(board, { type: "renameStep", step: 0, name: plan.strat.name });
}

// --- Validation --------------------------------------------------------------
// Share links are untrusted input: rebuild every item from known fields only.

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const color = (v) => (COLORS.includes(v) ? v : COLORS[0]);
const team = (v) => (TEAMS.includes(v) ? v : "ally");
const SLOTS = ["Ability1", "Ability2", "Grenade"];

function cleanItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  switch (raw.type) {
    case "agent":
      return { type: "agent", agentId: str(raw.agentId, 40), team: team(raw.team), x: coord(raw.x), y: coord(raw.y) };
    case "ability":
      if (!SLOTS.includes(raw.slot)) return null;
      return { type: "ability", agentId: str(raw.agentId, 40), slot: raw.slot, team: team(raw.team), x: coord(raw.x), y: coord(raw.y) };
    case "path": {
      if (!Array.isArray(raw.points)) return null;
      const points = raw.points
        .filter((p) => Array.isArray(p) && p.length === 2)
        .slice(0, MAX_POINTS)
        .map(([x, y]) => [coord(x), coord(y)]);
      if (points.length < 2) return null;
      return { type: "path", points, color: color(raw.color), arrow: raw.arrow === true };
    }
    case "circle":
      return { type: "circle", x: coord(raw.x), y: coord(raw.y), r: r1(clamp(Number(raw.r) || 0, 4, 400)), color: color(raw.color) };
    case "text": {
      const text = str(raw.text, MAX_TEXT);
      return text ? { type: "text", x: coord(raw.x), y: coord(raw.y), text, color: color(raw.color) } : null;
    }
    default:
      return null;
  }
}

export function cleanBoard(raw, mapIds) {
  if (!raw || typeof raw !== "object" || !mapIds.includes(raw.map) || !Array.isArray(raw.steps)) return null;
  let board = { v: 1, map: raw.map, nextId: 1, steps: [] };
  for (const s of raw.steps.slice(0, MAX_STEPS)) {
    if (!s || !Array.isArray(s.items)) continue;
    board.steps.push({ name: str(s.name, 40) || `Step ${board.steps.length + 1}`, items: [] });
    const step = board.steps.length - 1;
    for (const it of s.items.slice(0, MAX_ITEMS)) {
      const item = cleanItem(it);
      if (item) board = reduce(board, { type: "add", step, item });
    }
  }
  return board.steps.length ? board : null;
}

// --- Share encoding ------------------------------------------------------------
// JSON -> deflate-raw -> base64url. Ids are dropped (rebuilt on decode) to keep
// links short.

const MAX_DECODED = 1_000_000;

// Streams bytes through a (de)compressor, giving up once the output passes
// `limit` so a crafted link can't inflate into gigabytes.
async function pipe(bytes, stream, limit = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error("board too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const toB64url = (bytes) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromB64url = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export async function encodeBoard(board) {
  const slim = {
    map: board.map,
    steps: board.steps.map((s) => ({ name: s.name, items: s.items.map(({ id, ...rest }) => rest) })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(slim));
  return toB64url(await pipe(bytes, new CompressionStream("deflate-raw")));
}

export async function decodeBoard(code, mapIds) {
  try {
    const bytes = await pipe(fromB64url(code), new DecompressionStream("deflate-raw"), MAX_DECODED);
    return cleanBoard(JSON.parse(new TextDecoder().decode(bytes)), mapIds);
  } catch {
    return null;
  }
}
