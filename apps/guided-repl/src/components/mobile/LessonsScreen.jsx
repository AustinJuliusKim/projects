/**
 * Mobile lessons-list screen — the lesson spine treated like the Claude Code
 * app's sessions list: a full-screen, drill-in list. Reuses LessonRail (so
 * the lesson-item testids and lock/active logic are shared with desktop);
 * selecting an unlocked lesson enters the session screen.
 */

import LessonRail from "../LessonRail.jsx";
import AccountMenu from "../AccountMenu.jsx";

/**
 * @param {{
 *   lessons: Array<object>,
 *   activeLessonId: string,
 *   onSelectLesson: (lessonId: string) => void,
 * }} props
 */
export default function LessonsScreen({ lessons, activeLessonId, onSelectLesson }) {
  return (
    <div className="m-screen m-lessons-screen" data-testid="m-lessons-screen">
      <header className="m-header m-header-home">
        <h1 className="m-home-title">Guided REPL</h1>
        <AccountMenu />
      </header>
      <div className="m-lessons-list">
        <LessonRail lessons={lessons} activeLessonId={activeLessonId} onSelect={onSelectLesson} />
      </div>
    </div>
  );
}
