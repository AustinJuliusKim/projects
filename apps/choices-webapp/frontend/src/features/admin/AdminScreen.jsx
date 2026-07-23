import React from "react";
import AdminView from "@/features/admin/AdminView.jsx";
import FlagsPanel from "@/features/admin/FlagsPanel.jsx";

// The whole admin surface, loaded lazily (code-split out of the player
// bundle — main.jsx imports this via React.lazy). AdminView keeps its own
// ADMIN_SUBS owner gate for the activity data; FlagsPanel is group-gated
// server-side. Route-level access is the admin group claim (main.jsx).
export default function AdminScreen() {
  return (
    <>
      <AdminView />
      <div className="container">
        <FlagsPanel />
      </div>
    </>
  );
}
