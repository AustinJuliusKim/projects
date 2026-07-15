/**
 * Overlay shown when status === "awaiting_permission": shows the plan/tool
 * context and Approve/Deny buttons. On desktop it's a centered modal; on
 * mobile (asSheet) it renders inside a bottom sheet for reachable thumbs.
 */

import BottomSheet from "./mobile/BottomSheet.jsx";

/**
 * @param {{permission: {id: string, tool: string, input: object}, onApprove: () => void, onDeny: () => void, asSheet?: boolean}} props
 */
export default function PermissionModal({ permission, onApprove, onDeny, asSheet = false }) {
  const body = (
    <>
      <p className="permission-tool">{permission.tool}</p>
      <pre className="permission-input">{JSON.stringify(permission.input, null, 2)}</pre>
      <div className="permission-actions">
        <button type="button" data-testid="deny-button" onClick={onDeny}>
          Deny
        </button>
        <button type="button" data-testid="approve-button" onClick={onApprove}>
          Approve
        </button>
      </div>
    </>
  );

  if (asSheet) {
    // onClose === deny: dismissing a permission request is a denial.
    return (
      <BottomSheet title="Permission requested" onClose={onDeny} testId="permission-modal">
        {body}
      </BottomSheet>
    );
  }

  return (
    <div className="permission-modal-backdrop">
      <div className="permission-modal" data-testid="permission-modal">
        <h2>Permission requested</h2>
        {body}
      </div>
    </div>
  );
}
