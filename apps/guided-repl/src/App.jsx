/**
 * Top-level wiring: loads the compiled lesson manifest, drives the headless
 * lesson engine and useSession in guided mode, and lays out
 * Rail | Stage (Transcript + AnnotationCard + PromptComposer) | WorkspacePane
 * with PermissionModal as an overlay.
 *
 * Separation contract (Lesson Engine Spec §3): stage components receive only
 * the session stream state and the current mode string — never lesson
 * state. The Rail is the engine's only full subscriber.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { matchCommand } from "@guided-repl/protocol";
import { useIdentity } from "./identity/IdentityContext.jsx";
import { postLead, postEvent } from "./api/client.js";
import { markLesson, syncFromServer } from "./state/progressStore.js";
import { useSession } from "./state/useSession.js";
import { loadLesson } from "./lessons/lessonLoader.js";
import { useLessonEngine } from "./engine/useLessonEngine.js";
import { railModel, currentStep, evaluateRule } from "./engine/lessonEngine.js";
import Rail from "./components/Rail.jsx";
import Transcript from "./components/Transcript.jsx";
import PromptComposer from "./components/PromptComposer.jsx";
import WorkspacePane from "./components/WorkspacePane.jsx";
import PermissionModal from "./components/PermissionModal.jsx";
import AnnotationCard from "./components/AnnotationCard.jsx";
import AccountMenu from "./components/AccountMenu.jsx";
import AuthCallback from "./components/AuthCallback.jsx";
import MobileShell from "./components/mobile/MobileShell.jsx";
import { useIsMobile } from "./hooks/useIsMobile.js";

/** @returns {number} */
function readSpeedParam() {
  const raw = new URLSearchParams(window.location.search).get("speed");
  if (raw === null) return 1;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? 1 : parsed;
}

export default function App() {
  const [selectedLessonId, setSelectedLessonId] = useState("l1");
  // Display-only personalization (never lesson state): fixtures carry the
  // raw {{userName}} token; stage components substitute at render time.
  // null renders the "Demo User" default.
  const { anonId, userName, setUserName, user } = useIdentity();
  const [authCallback, setAuthCallback] = useState(
    () => window.location.pathname === "/auth/callback",
  );
  const [lessons, setLessons] = useState(null);
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);
  const speedMultiplier = readSpeedParam();
  const isMobile = useIsMobile();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const version = import.meta.env.VITE_FIXTURE_VERSION ?? "v2";
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

  const engine = useLessonEngine(lesson ?? null);
  const { state, prompt, approve, deny, interrupt, openFile, next } = useSession({
    mode: "guided",
    lesson,
    branches: ready ? loaded.branches : undefined,
    speedMultiplier,
    onDone: () => engine.dispatch({ type: "run_done" }),
  });

  const step = currentStep(engine.state);
  const rail = railModel(engine.state);

  // --- proof-gate instrumentation (all offline-tolerant fire-and-forget) ---

  // lesson_started once per loaded lesson + progress "started" mirror.
  useEffect(() => {
    if (!ready) return;
    postEvent("lesson_started", { lessonId: selectedLessonId }, anonId);
    markLesson(selectedLessonId, "started", { anonId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selectedLessonId]);

  // lesson_completed on the graduated transition.
  const wasGraduated = useRef(false);
  useEffect(() => {
    if (!engine.state.graduated) {
      wasGraduated.current = false;
      return;
    }
    if (wasGraduated.current) return;
    wasGraduated.current = true;
    postEvent("lesson_completed", { lessonId: selectedLessonId }, anonId);
    markLesson(selectedLessonId, "completed", { anonId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.state.graduated]);

  // Signed in: pull the server's progress into the local mirror.
  useEffect(() => {
    if (user) syncFromServer();
  }, [user]);

  // Entering an assertion step evaluates its rule against the settled
  // session state and records the result on the engine.
  useEffect(() => {
    if (step?.type !== "assertion" || engine.state.results[step.id]) return;
    const result = evaluateRule(step.rule, {
      files: state.files,
      messages: state.messages,
      results: engine.state.results,
    });
    engine.dispatch({ type: "assertion_evaluated", stepId: step.id, result });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, state.files, state.messages]);

  if (authCallback) {
    return <AuthCallback onDone={() => setAuthCallback(false)} />;
  }

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

  const isDrill = step?.type === "terminalDrill";

  function onComposerSubmit(text, branchId) {
    if (isDrill) {
      if (!matchCommand(step.expect, text)) {
        // Wrong command: submit without a branchId so the transport's
        // no-match path raises the hint affordance.
        prompt(text);
        return;
      }
      engine.dispatch({ type: "drill_matched" });
      prompt(text, `drill:${step.id}`);
      return;
    }
    engine.dispatch({ type: "prompt_matched", branchId });
    if (branchId) postEvent("branch_chosen", { lessonId: selectedLessonId, branchId }, anonId);
    prompt(text, branchId);
  }

  /**
   * Capture card Save: the name is already sanitized by the card (and
   * re-sanitized by setUserName before storage); the values land on the
   * engine result so the step completes. The lead/event POSTs are
   * fire-and-forget — capture never blocks on the network.
   */
  function onCapture(stepId, values, consent) {
    if (values.name) setUserName(values.name);
    if (values.email && anonId) {
      postLead({
        anonId,
        email: values.email,
        ...(values.name || userName ? { name: values.name ?? userName } : {}),
        consent,
        source: `${selectedLessonId}-${stepId}`,
      });
    }
    postEvent("capture_submitted", { lessonId: selectedLessonId, stepId, fields: Object.keys(values) }, anonId);
    engine.dispatch({ type: "capture_submitted", stepId, values: { ...values, consent } });
  }

  function onCaptureSkip(stepId) {
    engine.dispatch({ type: "capture_skipped", stepId });
  }

  function onRetry() {
    // Fresh session for the retry — the transport replays the seed snapshot
    // on the next matched prompt.
    interrupt();
    engine.dispatch({ type: "retry" });
  }

  const activeLessonMeta = lessons.find((l) => l.lessonId === selectedLessonId);
  const lessonTitle = activeLessonMeta?.title ?? loaded?.lesson?.title ?? "Lesson";
  const capturedEmail =
    Object.values(engine.state.results).find((r) => r?.values?.email)?.values.email ?? null;

  if (isMobile) {
    return (
      <div className="app-shell app-shell-mobile">
        <MobileShell
          lessons={lessons}
          activeLessonId={selectedLessonId}
          onSelectLesson={setSelectedLessonId}
          lessonTitle={lessonTitle}
          ready={ready}
          rail={rail}
          completionNext={ready ? loaded.lesson.completion?.next : null}
          onContinue={() => engine.dispatch({ type: "advance" })}
          onQuizAnswer={(stepId, answerIdx) => engine.dispatch({ type: "quiz_answered", stepId, answerIdx })}
          onRetry={onRetry}
          onCapture={onCapture}
          onCaptureSkip={onCaptureSkip}
          capturedEmail={capturedEmail}
          messages={state.messages}
          status={state.status}
          hint={state.hint}
          suggestions={ready ? loaded.lesson.suggestions : []}
          onSubmit={onComposerSubmit}
          freeText={isDrill}
          annotation={state.annotation}
          onNext={next}
          files={state.files}
          openFile={state.openFile}
          onOpenFile={openFile}
          userName={userName}
        />
        {ready && state.status === "awaiting_permission" && state.permission && (
          <PermissionModal permission={state.permission} onApprove={approve} onDeny={deny} asSheet />
        )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Guided REPL</h1>
        <AccountMenu />
      </header>
      <main className="split-pane">
        <Rail
          lessons={lessons}
          activeLessonId={selectedLessonId}
          onSelectLesson={setSelectedLessonId}
          rail={rail}
          completionNext={ready ? loaded.lesson.completion?.next : null}
          onContinue={() => engine.dispatch({ type: "advance" })}
          onQuizAnswer={(stepId, answerIdx) => engine.dispatch({ type: "quiz_answered", stepId, answerIdx })}
          onRetry={onRetry}
          onCapture={onCapture}
          onCaptureSkip={onCaptureSkip}
          userName={userName}
          capturedEmail={capturedEmail}
        />
        <section className="pane pane-stage">
          {error && <div className="load-error">Failed to load lesson: {error}</div>}
          {!error && !ready && <div className="load-status">Loading lesson…</div>}
          {ready && (
            <>
              <Transcript messages={state.messages} status={state.status} userName={userName} />
              <AnnotationCard annotation={state.annotation} onNext={next} />
              <PromptComposer
                suggestions={loaded.lesson.suggestions}
                status={state.status}
                hint={state.hint}
                onSubmit={onComposerSubmit}
                freeText={isDrill}
                userName={userName}
              />
            </>
          )}
        </section>
        <section className="pane pane-right">
          {ready && <WorkspacePane files={state.files} openFile={state.openFile} onOpenFile={openFile} userName={userName} />}
        </section>
      </main>
      {ready && state.status === "awaiting_permission" && state.permission && (
        <PermissionModal permission={state.permission} onApprove={approve} onDeny={deny} />
      )}
    </div>
  );
}
