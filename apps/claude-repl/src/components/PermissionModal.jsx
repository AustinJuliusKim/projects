import React from "react";

// Surfaces a permission request from Claude Code (Plan / Accept-edits modes).
// The user approves or denies; the decision flows back over the WS.
export default function PermissionModal({ permission, onApprove, onDeny }) {
  if (!permission) return null;
  const { id, tool, input } = permission;
  return (
    <div className="modal-backdrop">
      <div className="modal permission">
        <h3>Allow this action?</h3>
        <div className="permission-tool">
          <span className="tool-chip">{tool}</span>
        </div>
        <pre className="permission-input">{JSON.stringify(input, null, 2)}</pre>
        <div className="permission-actions">
          <button className="deny" onClick={() => onDeny(id)}>
            Deny
          </button>
          <button className="approve" onClick={() => onApprove(id)}>
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
