/**
 * Mobile shell — recomposes the same feature components as the desktop
 * split-pane into the Claude Code mobile app pattern:
 *   • a full-screen lessons list (the lesson spine ≈ sessions list), and
 *   • a session screen: header (‹ back · title · ⋯) + a single Transcript
 *     scroll + a pinned bottom composer, with Files / Lesson / overflow
 *     surfaced as bottom sheets.
 *
 * It owns only presentation state (`screen`, `openSheet`); all lesson/session
 * logic stays upstream. Stage components still receive stream state + mode
 * only — the separation contract (Lesson Engine Spec §3) is intact.
 */

import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import Transcript from "../Transcript.jsx";
import PromptComposer from "../PromptComposer.jsx";
import WorkspacePane from "../WorkspacePane.jsx";
import AnnotationCard from "../AnnotationCard.jsx";
import BottomSheet from "./BottomSheet.jsx";
import MobileHeader from "./MobileHeader.jsx";
import LessonsScreen from "./LessonsScreen.jsx";
import LessonSheet from "./LessonSheet.jsx";
import OverflowMenu from "./OverflowMenu.jsx";

export default function MobileShell({
  // lessons list
  lessons,
  activeLessonId,
  onSelectLesson,
  lessonTitle,
  ready,
  // rail model + callbacks
  rail,
  completionNext,
  onContinue,
  onQuizAnswer,
  onRetry,
  onCapture,
  onCaptureSkip,
  capturedEmail,
  // stage
  messages,
  status,
  hint,
  suggestions,
  onSubmit,
  freeText,
  annotation,
  onNext,
  // workspace
  files,
  openFile,
  onOpenFile,
  // shared
  userName = null,
}) {
  const [screen, setScreen] = useState("lessons");
  const [openSheet, setOpenSheet] = useState(null); // null | "files" | "lesson" | "menu"

  // Interactive lesson moments (quiz/capture/graduation) shouldn't hide
  // behind the transcript — surface the lesson sheet when one becomes
  // current. Plain instruction reading stays in the always-visible bar.
  const attentionKey = useMemo(() => {
    const step = rail?.currentStep;
    if (rail?.graduated) return "graduated";
    if (step?.type === "quiz" && !rail.results[step.id]?.pass) return `quiz:${step.id}`;
    if (step?.type === "capture" && !rail.results[step.id]) return `capture:${step.id}`;
    return null;
  }, [rail]);

  useEffect(() => {
    if (screen === "session" && attentionKey) setOpenSheet("lesson");
  }, [attentionKey, screen]);

  function enterLesson(lessonId) {
    onSelectLesson(lessonId);
    setScreen("session");
    setOpenSheet(null);
  }

  function backToLessons() {
    setScreen("lessons");
    setOpenSheet(null);
  }

  function openFileSheet(path) {
    if (path) onOpenFile(path);
    setOpenSheet("files");
  }

  if (screen === "lessons") {
    return (
      <LessonsScreen lessons={lessons} activeLessonId={activeLessonId} onSelectLesson={enterLesson} />
    );
  }

  // Session screen
  const dots = rail?.dots ?? [];
  const done = dots.filter((d) => d.state === "done").length;
  const subtitle = dots.length ? `Step ${Math.min(done + 1, dots.length)} of ${dots.length}` : "Guided REPL";
  const fileCount = Object.keys(files ?? {}).length;

  return (
    <div className="m-screen m-session-screen" data-testid="m-session-screen">
      <MobileHeader
        title={lessonTitle ?? "Lesson"}
        subtitle={subtitle}
        onBack={backToLessons}
        onMenu={() => setOpenSheet("menu")}
      />

      {rail?.instructionMd && (
        <button
          type="button"
          className="m-lesson-bar"
          data-testid="m-lesson-bar"
          onClick={() => setOpenSheet("lesson")}
        >
          <div
            className="m-lesson-bar-copy"
            // Authored first-party lesson copy from the compiled manifest.
            dangerouslySetInnerHTML={{ __html: marked.parse(rail.instructionMd) }}
          />
          <span className="m-lesson-bar-chevron">›</span>
        </button>
      )}

      <main className="m-session-body">
        {ready ? (
          <>
            <Transcript
              messages={messages}
              status={status}
              userName={userName}
              onOpenFile={openFileSheet}
            />
            <AnnotationCard annotation={annotation} onNext={onNext} />
          </>
        ) : (
          <div className="load-status">Loading lesson…</div>
        )}
      </main>

      <div className="m-actionbar">
        <button
          type="button"
          className={`m-pill ${attentionKey ? "m-pill-attention" : ""}`}
          data-testid="m-open-lesson"
          onClick={() => setOpenSheet("lesson")}
        >
          ≣ Lesson
        </button>
        <button
          type="button"
          className="m-pill"
          data-testid="m-open-files"
          onClick={() => openFileSheet(null)}
        >
          ⌘ Files{fileCount ? ` · ${fileCount}` : ""}
        </button>
      </div>

      {ready && (
        <div className="m-composer-dock">
          <PromptComposer
            suggestions={suggestions}
            status={status}
            hint={hint}
            onSubmit={onSubmit}
            freeText={freeText}
            userName={userName}
            compact
          />
        </div>
      )}

      {openSheet === "files" && (
        <BottomSheet title="Files" onClose={() => setOpenSheet(null)} testId="m-sheet-files" full>
          <WorkspacePane files={files} openFile={openFile} onOpenFile={onOpenFile} userName={userName} />
        </BottomSheet>
      )}

      {openSheet === "lesson" && (
        <BottomSheet title="Lesson" onClose={() => setOpenSheet(null)} testId="m-sheet-lesson">
          <LessonSheet
            rail={rail}
            completionNext={completionNext}
            onContinue={() => {
              onContinue();
              setOpenSheet(null);
            }}
            onQuizAnswer={onQuizAnswer}
            onRetry={() => {
              onRetry();
              setOpenSheet(null);
            }}
            onCapture={onCapture}
            onCaptureSkip={onCaptureSkip}
            onNextLesson={(lessonId) => enterLesson(lessonId)}
            userName={userName}
            capturedEmail={capturedEmail}
          />
        </BottomSheet>
      )}

      {openSheet === "menu" && (
        <BottomSheet title={lessonTitle ?? "Lesson"} onClose={() => setOpenSheet(null)} testId="m-sheet-menu">
          <OverflowMenu
            onRestart={() => {
              onRetry();
              setOpenSheet(null);
            }}
            onBackToLessons={backToLessons}
          />
        </BottomSheet>
      )}
    </div>
  );
}
