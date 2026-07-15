/**
 * Mobile session header, modeled on the Claude Code app: a back chevron
 * (returns to the lessons list), a centered lesson title + subtitle, and a
 * `···` overflow trigger that opens the menu sheet.
 */

/**
 * @param {{
 *   title: string,
 *   subtitle?: string,
 *   onBack: () => void,
 *   onMenu: () => void,
 * }} props
 */
export default function MobileHeader({ title, subtitle, onBack, onMenu }) {
  return (
    <header className="m-header" data-testid="m-header">
      <button type="button" className="m-icon-btn" aria-label="Back to lessons" data-testid="m-back" onClick={onBack}>
        ‹
      </button>
      <div className="m-header-titles">
        <span className="m-header-title">{title}</span>
        {subtitle && <span className="m-header-sub">{subtitle}</span>}
      </div>
      <button type="button" className="m-icon-btn" aria-label="Menu" data-testid="m-menu-trigger" onClick={onMenu}>
        ⋯
      </button>
    </header>
  );
}
