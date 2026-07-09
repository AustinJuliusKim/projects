/**
 * React wrapper for the headless lesson engine: a useReducer plus a
 * lesson_loaded effect on lesson identity change.
 */

import { useEffect, useReducer } from "react";
import { engineReducer, createEngineState } from "./lessonEngine.js";

/**
 * @param {object|null} lesson indexed lesson (or null while loading)
 */
export function useLessonEngine(lesson) {
  const [state, dispatch] = useReducer(engineReducer, lesson, createEngineState);

  useEffect(() => {
    dispatch({ type: "lesson_loaded", lesson });
  }, [lesson]);

  return { state, dispatch };
}
