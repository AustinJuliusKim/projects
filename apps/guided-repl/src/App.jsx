/**
 * Top-level wiring: loads lessons.json, drives useSession in guided mode for
 * whichever lesson is selected, and lays out LessonRail | Transcript+PromptBuilder
 * | WorkspacePane, with PermissionModal/AnnotationCard as overlays and
 * GradeBanner once done.
 */

import { useEffect, useMemo, useState } from "react";
import { useSession } from "./state/useSession.js";
import { loadLesson } from "./lessons/lessonLoader.js";
import LessonRail from "./components/LessonRail.jsx";
import Transcript from "./components/Transcript.jsx";
import PromptBuilder from "./components/PromptBuilder.jsx";
import WorkspacePane from "./components/WorkspacePane.jsx";
import PermissionModal from "./components/PermissionModal.jsx";
import GradeBanner from "./components/GradeBanner.jsx";
import AnnotationCard from "./components/AnnotationCard.jsx";

/** @returns {number} */
function readSpeedParam() {
  const raw = new URLSearchParams(window.location.search).get("speed");
  if (raw === null) return 1;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? 1 : parsed;
}

export default function App() {
  const [selectedLessonId, setSelectedLessonId] = useState("l1");
  const [lessons, setLessons] = useState(null);
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);
  const speedMultiplier = readSpeedParam();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const version = import.meta.env.VITE_FIXTURE_VERSION ?? "v1";
    loadLesson(import.meta.env.BASE_URL, version, selectedLessonId)
      .then((result) => {
        if (cancelled) return;
        setLessons(result.lessons);
        setLoaded(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedLessonId]);

  // Only "ready" once `loaded` actually reflects the currently selected
  // lesson — during a lesson switch, `loaded` still holds the previous
  // lesson's data until the new fetch resolves.
  const ready = Boolean(loaded && loaded.lesson.lessonId === selectedLessonId);

  // Stable identity: a fresh object each render would remount the transport
  // mid-playback via useSession's connect effect.
  const lesson = useMemo(
    () => (ready ? { ...loaded.lesson, snapshot: loaded.snapshot } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, loaded],
  );
  const { state, prompt, approve, deny, openFile, next } = useSession({
    mode: "guided",
    lesson,
    branches: ready ? loaded.branches : undefined,
    speedMultiplier,
  });

  if (error && !lessons) {
    return (
      <div className="app-shell">
        <div className="load-error">Failed to load lesson: {error}</div>
      </div>
    );
  }

  if (!lessons) {
    return (
      <div className="app-shell">
        <div className="load-status">Loading lesson…</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Guided REPL</h1>
      </header>
      <main className="split-pane">
        <section className="pane pane-left">
          <LessonRail lessons={lessons} activeLessonId={selectedLessonId} onSelect={setSelectedLessonId} />
          {error && <div className="load-error">Failed to load lesson: {error}</div>}
          {!error && !ready && <div className="load-status">Loading lesson…</div>}
          {ready && (
            <>
              <Transcript messages={state.messages} status={state.status} />
              <AnnotationCard annotation={state.annotation} onNext={next} />
              <PromptBuilder
                promptChoices={loaded.lesson.promptChoices}
                status={state.status}
                hint={state.hint}
                onSubmit={prompt}
              />
              {state.status === "done" && (
                <GradeBanner assertion={loaded.lesson.assertion} files={state.files} messages={state.messages} />
              )}
            </>
          )}
        </section>
        <section className="pane pane-right">
          {ready && <WorkspacePane files={state.files} openFile={state.openFile} onOpenFile={openFile} />}
        </section>
      </main>
      {ready && state.status === "awaiting_permission" && state.permission && (
        <PermissionModal permission={state.permission} onApprove={approve} onDeny={deny} />
      )}
    </div>
  );
}
