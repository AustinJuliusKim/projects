import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCompletedGame,
  emptyStats,
  utcDay,
  RECENT_GAMES_CAP,
  TOP_WINNERS_CAP,
} from "./stats.mjs";

const DAY1 = Date.UTC(2026, 6, 1, 12); // 2026-07-01
const DAY2 = Date.UTC(2026, 6, 2, 12);
const DAY4 = Date.UTC(2026, 6, 4, 12);

function user(overrides = {}) {
  return { pk: "USER#u1", userId: "u1", stats: emptyStats(), recentGames: [], ...overrides };
}

const rec = (completedAt, winnerLabel = "Pizza") => ({
  pairingId: "abc",
  number: 1,
  winnerLabel,
  choices: ["Pizza", "Tacos", "Sushi", "Ramen"],
  completedAt,
});

test("first game starts a 1-day streak", () => {
  const u = applyCompletedGame(user(), rec(DAY1));
  assert.equal(u.stats.gamesPlayed, 1);
  assert.equal(u.stats.currentStreak, 1);
  assert.equal(u.stats.bestStreak, 1);
  assert.equal(u.stats.lastPlayedDay, "2026-07-01");
  assert.equal(u.recentGames.length, 1);
});

test("same-day games don't extend the streak", () => {
  let u = applyCompletedGame(user(), rec(DAY1));
  u = applyCompletedGame(u, rec(DAY1 + 3600_000));
  assert.equal(u.stats.gamesPlayed, 2);
  assert.equal(u.stats.currentStreak, 1);
});

test("consecutive days extend, a gap resets, best is kept", () => {
  let u = applyCompletedGame(user(), rec(DAY1));
  u = applyCompletedGame(u, rec(DAY2));
  assert.equal(u.stats.currentStreak, 2);
  assert.equal(u.stats.bestStreak, 2);
  u = applyCompletedGame(u, rec(DAY4)); // skipped 07-03
  assert.equal(u.stats.currentStreak, 1);
  assert.equal(u.stats.bestStreak, 2);
});

test("streak crosses a UTC month boundary", () => {
  const jun30 = Date.UTC(2026, 5, 30, 23);
  let u = applyCompletedGame(user(), rec(jun30));
  u = applyCompletedGame(u, rec(DAY1));
  assert.equal(u.stats.currentStreak, 2);
});

test("topWinners counts labels and evicts past the cap", () => {
  let u = user();
  u = applyCompletedGame(u, rec(DAY1, "Pizza"));
  u = applyCompletedGame(u, rec(DAY1, "Pizza"));
  u = applyCompletedGame(u, rec(DAY1, "Tacos"));
  assert.equal(u.stats.topWinners.Pizza, 2);
  assert.equal(u.stats.topWinners.Tacos, 1);

  for (let i = 0; i < TOP_WINNERS_CAP + 5; i++) {
    u = applyCompletedGame(u, rec(DAY1, `Label${i}`));
  }
  const labels = Object.keys(u.stats.topWinners);
  assert.equal(labels.length, TOP_WINNERS_CAP);
  assert.ok(labels.includes("Pizza")); // highest count survives eviction
});

test("recentGames prepends newest-first and caps", () => {
  let u = user();
  for (let i = 1; i <= RECENT_GAMES_CAP + 10; i++) {
    u = applyCompletedGame(u, { ...rec(DAY1 + i), number: i });
  }
  assert.equal(u.recentGames.length, RECENT_GAMES_CAP);
  assert.equal(u.recentGames[0].number, RECENT_GAMES_CAP + 10);
});

test("utcDay formats as YYYY-MM-DD", () => {
  assert.equal(utcDay(DAY1), "2026-07-01");
});
