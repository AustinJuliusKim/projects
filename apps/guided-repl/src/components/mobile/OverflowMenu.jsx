/**
 * Contents of the `···` overflow sheet (Claude Code app's session menu). The
 * session analogs that make sense for a lesson: restart the current lesson,
 * jump back to the lessons list, and the account controls. (Share / Rename /
 * Archive from the app have no lesson analog and are intentionally omitted.)
 */

import AccountMenu from "../AccountMenu.jsx";

/**
 * @param {{
 *   onRestart: () => void,
 *   onBackToLessons: () => void,
 * }} props
 */
export default function OverflowMenu({ onRestart, onBackToLessons }) {
  return (
    <div className="m-menu" data-testid="m-menu">
      <button
        type="button"
        className="m-menu-row"
        data-testid="m-menu-restart"
        onClick={onRestart}
      >
        <span className="m-menu-glyph">↻</span>
        Restart lesson
      </button>
      <button
        type="button"
        className="m-menu-row"
        data-testid="m-menu-lessons"
        onClick={onBackToLessons}
      >
        <span className="m-menu-glyph">≣</span>
        All lessons
      </button>
      <div className="m-menu-divider" />
      <div className="m-menu-account">
        <AccountMenu />
      </div>
    </div>
  );
}
