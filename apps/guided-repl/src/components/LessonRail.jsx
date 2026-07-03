/**
 * Left rail: every lesson from lessons.json. Unlocked lessons are clickable
 * (switches the active lesson); locked lessons render greyed out with a
 * lock icon and are inert.
 */

import { lessonKind } from "../lessons/lessonKind.js";

/**
 * @param {{lessons: Array<{lessonId: string, title: string, locked: boolean, assertion?: object}>, activeLessonId: string, onSelect: (lessonId: string) => void}} props
 */
export default function LessonRail({ lessons, activeLessonId, onSelect }) {
  return (
    <nav className="lesson-rail" data-testid="lesson-rail">
      {lessons.map((lesson) => {
        const isLocked = Boolean(lesson.locked);
        const isActive = !isLocked && lesson.lessonId === activeLessonId;
        const className = [
          "lesson-item",
          isActive ? "lesson-item-active" : "",
          isLocked ? "lesson-item-locked" : "",
        ]
          .filter(Boolean)
          .join(" ");

        if (isLocked) {
          return (
            <div className={className} key={lesson.lessonId}>
              <span className="lock-icon">🔒</span>
              {lesson.title}
            </div>
          );
        }

        const kind = lessonKind(lesson.assertion);
        return (
          <button
            type="button"
            className={className}
            data-testid="lesson-item"
            data-lesson-id={lesson.lessonId}
            key={lesson.lessonId}
            onClick={() => onSelect(lesson.lessonId)}
          >
            <span>{lesson.title}</span>
            <span
              className={`lesson-kind lesson-kind-${kind.kind}`}
              data-testid="lesson-kind"
              title={kind.label}
            >
              {kind.glyph}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
