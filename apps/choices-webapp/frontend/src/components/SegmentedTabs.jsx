import React from "react";

// Shared segmented pill switcher (the .segmented/.seg-tab pattern from the
// History page): one visible panel at a time, app-native rather than a long
// stacked scroll. Controlled: `tabs` is [{ id, label }], `value` the active
// id, `onChange(id)` fires on select. Callers own what renders below.
export default function SegmentedTabs({ tabs, value, onChange, label }) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          className={`seg-tab${value === t.id ? " active" : ""}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
