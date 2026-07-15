/**
 * Reusable mobile bottom sheet — the detail surface pattern from the Claude
 * Code mobile app (Bash / Edit / Select-mode sheets). Portals to <body>,
 * dims the backdrop, slides a rounded panel up from the bottom with a grab
 * handle + title + close affordance. Backdrop click or Escape closes; the
 * grab handle supports swipe-down to dismiss. Honors the home-indicator
 * safe area. Built on the same backdrop conventions as PermissionModal.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * @param {{
 *   title?: string,
 *   onClose: () => void,
 *   children: import("react").ReactNode,
 *   testId?: string,
 *   full?: boolean,
 * }} props
 */
export default function BottomSheet({ title, onClose, children, testId, full = false }) {
  const startY = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onHandleTouchStart(e) {
    startY.current = e.touches[0].clientY;
  }
  function onHandleTouchMove(e) {
    if (startY.current === null) return;
    const dy = e.touches[0].clientY - startY.current;
    if (panelRef.current && dy > 0) {
      panelRef.current.style.transform = `translateY(${dy}px)`;
    }
  }
  function onHandleTouchEnd(e) {
    if (startY.current === null) return;
    const dy = e.changedTouches[0].clientY - startY.current;
    if (panelRef.current) panelRef.current.style.transform = "";
    startY.current = null;
    if (dy > 80) onClose();
  }

  return createPortal(
    <div className="m-sheet-backdrop" onClick={onClose} data-testid="m-sheet-backdrop">
      <div
        ref={panelRef}
        className={`m-sheet ${full ? "m-sheet-full" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId ?? "m-sheet"}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="m-sheet-grip"
          onTouchStart={onHandleTouchStart}
          onTouchMove={onHandleTouchMove}
          onTouchEnd={onHandleTouchEnd}
        >
          <span className="m-sheet-handle" />
        </div>
        <div className="m-sheet-head">
          <button
            type="button"
            className="m-sheet-close"
            aria-label="Close"
            data-testid="m-sheet-close"
            onClick={onClose}
          >
            ✕
          </button>
          {title && <span className="m-sheet-title">{title}</span>}
        </div>
        <div className="m-sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
