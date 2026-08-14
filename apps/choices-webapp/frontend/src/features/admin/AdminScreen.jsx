import React, { useState } from "react";
import AdminView from "@/features/admin/AdminView.jsx";
import FlagsPanel from "@/features/admin/FlagsPanel.jsx";
import SegmentedTabs from "@/components/SegmentedTabs.jsx";

// The whole admin surface, loaded lazily (code-split out of the player
// bundle — main.jsx imports this via React.lazy). A segmented pill switches
// between the two panels; AdminScreen owns the .admin-view column so the
// pill and both panels share one layout. AdminView keeps its own ADMIN_SUBS
// owner gate for the activity data; FlagsPanel is group-gated server-side.
// Route-level access is the admin group claim (main.jsx). Switching tabs
// unmounts the hidden panel, which also stops AdminView's 30s poll.
export default function AdminScreen() {
  const [tab, setTab] = useState("dashboard");
  return (
    <div className="admin-view">
      <SegmentedTabs
        label="Admin sections"
        tabs={[
          { id: "dashboard", label: "Dashboard" },
          { id: "flags", label: "Flags" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "dashboard" ? <AdminView /> : <FlagsPanel />}
    </div>
  );
}
