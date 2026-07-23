import React, { useEffect, useState } from "react";
import { adminListFlags, adminSetFlag } from "@/lib/api.js";
import Button from "@/components/Button.jsx";

// Feature-flag admin panel (§10c). Lives in the code-split admin bundle —
// never ships to player sessions. Optimistic-concurrency aware: a 409 means
// another operator (or another tab) changed flags since our list; we refetch
// and tell the operator instead of silently overwriting.
export default function FlagsPanel() {
  const [data, setData] = useState(null); // { flags, version }
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null); // flag name mid-toggle

  async function refresh() {
    try {
      setData(await adminListFlags());
      setError(null);
    } catch (err) {
      setError(err.code === "NOT_ADMIN" ? "Flag admin requires the admin group." : err.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function toggle(name, current) {
    setBusy(name);
    setNotice(null);
    try {
      setData(await adminSetFlag(name, !current, data.version));
    } catch (err) {
      if (err.code === "WRITE_CONFLICT") {
        setNotice("Flags changed elsewhere — refreshed, try again.");
        await refresh();
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading flags…</p>;

  return (
    <section className="flags-panel">
      <h2>Feature flags</h2>
      {notice && <p className="muted">{notice}</p>}
      {Object.entries(data.flags).map(([name, f]) => (
        <div className="flag-row" key={name}>
          <div className="flag-info">
            <code>{name}</code>
            <span className={`tag flag-type-${f.type}`}>{f.type}</span>
            {!f.public && <span className="tag">server-only</span>}
            <p className="muted">{f.description}</p>
            {f.updatedAt && (
              <p className="muted flag-meta">
                changed {new Date(f.updatedAt).toLocaleString()} (default:{" "}
                {String(f.default)})
              </p>
            )}
          </div>
          <Button
            variant={f.enabled ? "primary" : "ghost"}
            busy={busy === name}
            onClick={() => toggle(name, f.enabled)}
          >
            {f.enabled ? "On" : "Off"}
          </Button>
        </div>
      ))}
    </section>
  );
}
