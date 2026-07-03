/**
 * Fixture and snapshot schema for recorded lesson runs.
 *
 * @typedef {import("./frames.js").ServerFrame} ServerFrame
 * @typedef {import("./assertions.js").Assertion} Assertion
 *
 * @typedef {{title: string, body: string}} Annotation
 * @typedef {{frame: ServerFrame, delayMs: number, origDelayMs?: number, annotation?: Annotation}} FrameEvent
 * @typedef {{awaitClient: "permission", choices: string[]}} AwaitClientMarker
 * @typedef {FrameEvent|AwaitClientMarker} FixtureEvent
 *
 * @typedef {object} FixtureEnvelope
 * @property {1} fixtureVersion
 * @property {string} claudeCodeVersion
 * @property {string} lessonId
 * @property {string} branchId
 * @property {string} recordedAt
 * @property {string} seedSnapshotId
 * @property {string} permissionMode
 * @property {string} expectedPrompt
 * @property {FixtureEvent[]} events
 * @property {Assertion} assertion
 *
 * @typedef {{path: string, content: string}} SnapshotFile
 * @typedef {{snapshotId: string, files: SnapshotFile[]}} SnapshotManifest
 */

import { isServerFrame } from "./frames.js";
import { validateAssertion } from "./assertions.js";

const isPlainObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v) => typeof v === "string";
const isNumber = (v) => typeof v === "number";
const isArray = (v) => Array.isArray(v);

/**
 * Validates a FixtureEvent (either a {frame, delayMs, origDelayMs?} entry
 * or an {awaitClient, choices} marker).
 *
 * @param {unknown} e
 * @param {number} i index, for error messages
 */
function validateFixtureEvent(e, i) {
  if (!isPlainObject(e)) {
    throw new Error(`Invalid fixture: events[${i}] is not an object`);
  }

  if ("awaitClient" in e) {
    if (e.awaitClient !== "permission") {
      throw new Error(`Invalid fixture: events[${i}].awaitClient must be "permission"`);
    }
    if (!isArray(e.choices) || !e.choices.every(isString)) {
      throw new Error(`Invalid fixture: events[${i}].choices must be an array of strings`);
    }
    return;
  }

  if (!isServerFrame(e.frame)) {
    throw new Error(`Invalid fixture: events[${i}].frame is not a valid ServerFrame`);
  }
  if (!isNumber(e.delayMs)) {
    throw new Error(`Invalid fixture: events[${i}].delayMs must be a number`);
  }
  if ("origDelayMs" in e && !isNumber(e.origDelayMs)) {
    throw new Error(`Invalid fixture: events[${i}].origDelayMs must be a number`);
  }
  if ("annotation" in e) {
    if (!isPlainObject(e.annotation)) {
      throw new Error(`Invalid fixture: events[${i}].annotation must be an object`);
    }
    if (!isString(e.annotation.title)) {
      throw new Error(`Invalid fixture: events[${i}].annotation.title must be a string`);
    }
    if (!isString(e.annotation.body)) {
      throw new Error(`Invalid fixture: events[${i}].annotation.body must be a string`);
    }
  }
}

/**
 * Validates a FixtureEnvelope, throwing with a precise message on the first
 * problem found.
 *
 * @param {unknown} obj
 * @returns {asserts obj is FixtureEnvelope}
 * @throws {Error}
 */
export function validateFixture(obj) {
  if (!isPlainObject(obj)) {
    throw new Error("Invalid fixture: not an object");
  }
  if (obj.fixtureVersion !== 1) {
    throw new Error("Invalid fixture: fixtureVersion must be 1");
  }
  for (const key of ["claudeCodeVersion", "lessonId", "branchId", "recordedAt", "seedSnapshotId", "permissionMode", "expectedPrompt"]) {
    if (!isString(obj[key])) {
      throw new Error(`Invalid fixture: ${key} must be a string`);
    }
  }
  if (!isArray(obj.events)) {
    throw new Error("Invalid fixture: events must be an array");
  }
  obj.events.forEach(validateFixtureEvent);

  try {
    validateAssertion(obj.assertion);
  } catch (err) {
    throw new Error(`Invalid fixture: assertion invalid — ${err.message}`);
  }
}

/**
 * Validates a SnapshotManifest, throwing with a precise message on the
 * first problem found.
 *
 * @param {unknown} obj
 * @returns {asserts obj is SnapshotManifest}
 * @throws {Error}
 */
export function validateSnapshot(obj) {
  if (!isPlainObject(obj)) {
    throw new Error("Invalid snapshot: not an object");
  }
  if (!isString(obj.snapshotId)) {
    throw new Error("Invalid snapshot: snapshotId must be a string");
  }
  if (!isArray(obj.files)) {
    throw new Error("Invalid snapshot: files must be an array");
  }
  obj.files.forEach((f, i) => {
    if (!isPlainObject(f)) {
      throw new Error(`Invalid snapshot: files[${i}] is not an object`);
    }
    if (!isString(f.path)) {
      throw new Error(`Invalid snapshot: files[${i}].path must be a string`);
    }
    if (f.path.startsWith("/")) {
      throw new Error(`Invalid snapshot: files[${i}].path must be workspace-relative (no leading /)`);
    }
    if (!isString(f.content)) {
      throw new Error(`Invalid snapshot: files[${i}].content must be a string`);
    }
  });
}
