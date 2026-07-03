/**
 * Overlay shown when status === "awaiting_permission": shows the plan/tool
 * context and Approve/Deny buttons.
 */

/**
 * @param {{permission: {id: string, tool: string, input: object}, onApprove: () => void, onDeny: () => void}} props
 */
export default function PermissionModal({ permission, onApprove, onDeny }) {
  return (
    <div className="permission-modal-backdrop">
      <div className="permission-modal" data-testid="permission-modal">
        <h2>Permission requested</h2>
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
      </div>
    </div>
  );
}
