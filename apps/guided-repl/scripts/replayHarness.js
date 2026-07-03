#!/usr/bin/env node
/**
 * M3 gate runner: replays a recorded fixture (or a synthetic one) at
 * speedMultiplier 0 through the fixturePlayer + reducer and prints the
 * final reconstructed state.
 *
 * Usage: node scripts/replayHarness.js <fixturePath> <snapshotPath>
 */

import { readFileSync } from "node:fs";
import { createFixturePlayer } from "../src/player/fixturePlayer.js";
import { reducer, createInitialState } from "../src/state/reducer.js";

const [, , fixturePath, snapshotPath] = process.argv;

if (!fixturePath || !snapshotPath) {
  console.error("Usage: node scripts/replayHarness.js <fixturePath> <snapshotPath>");
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));

let state = createInitialState();
let player;

player = createFixturePlayer({
  fixture,
  snapshot,
  speedMultiplier: 0,
  onFrame: (frame) => {
    state = reducer(state, frame);
  },
  onStateChange: (playerState) => {
    // Headless MVP: auto-approve any permission gate so replay always
    // reaches "done" without a human in the loop.
    if (playerState === "awaitingClient") {
      player.resolvePermission("approve");
    }
  },
});

await player.play();

const files = Object.keys(state.files).sort();
const indexHtml = state.files["index.html"];

const result = {
  status: state.status,
  fileCount: files.length,
  files,
  "index.html contains <h1>": Boolean(indexHtml && indexHtml.content.includes("<h1>")),
};

console.log(JSON.stringify(result, null, 2));

if (state.status !== "done") {
  process.exit(1);
}
