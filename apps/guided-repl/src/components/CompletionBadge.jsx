/**
 * Free shareable completion badge shown at graduation (certificates stay
 * paid-tier). Name is display-only interpolation — React escapes the sink.
 */

import { interpolateUserName } from "@guided-repl/protocol";

/**
 * @param {{userName: string|null}} props
 */
export default function CompletionBadge({ userName }) {
  return (
    <div className="completion-badge" data-testid="completion-badge">
      <span className="completion-badge-glyph">★</span>
      <div>
        <div className="completion-badge-title">
          {interpolateUserName("{{userName}} shipped the guided track", userName)}
        </div>
        <div className="completion-badge-sub">8 lessons · Claude Code, hands on</div>
      </div>
    </div>
  );
}
