import React, { useEffect, useState } from "react";
import { getAdminOverview } from "./api.js";
import { getProfile, signIn } from "./auth.js";
import AdminSkeleton from "./AdminSkeleton.jsx";

// Owner-only activity dashboard (anonymous aggregates). Polls every 30s using
// the same self-scheduling / visibility-aware loop as PlayView, at a slow fixed
// interval to bound the backing Scan cost. Renders hero stat tiles + a single
// bar list; no identifiable per-user data ever crosses the wire.
const POLL_MS = 30_000;
const POLL_ERROR_MAX_MS = 120_000;

export default function AdminView() {
  const [data, setData] = useState(null);
  // status: "loading" | "ok" | "signedout" | "forbidden" | "error"
  const [status, setStatus] = useState(getProfile() ? "loading" : "signedout");
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!getProfile()) return; // signed out — nothing to poll
    let alive = true;
    let timer = null;
    let errorStreak = 0;

    async function poll() {
      timer = null;
      try {
        const res = await getAdminOverview();
        if (!alive) return;
        errorStreak = 0;
        setData(res);
        setStatus("ok");
      } catch (err) {
        if (!alive) return;
        if (err.code === "NOT_ADMIN") {
          setStatus("forbidden");
          return; // not the owner — stop polling
        }
        if (err.code === "SIGN_IN_REQUIRED" || err.status === 401) {
          setStatus("signedout");
          return;
        }
        errorStreak += 1;
        setError(err.message);
        setStatus("error");
      }
      schedule();
    }

    function schedule() {
      if (!alive || document.visibilityState === "hidden") return;
      const base = Math.min(POLL_MS * 2 ** errorStreak, POLL_ERROR_MAX_MS);
      timer = setTimeout(poll, base * (0.8 + Math.random() * 0.4));
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") {
        if (timer) clearTimeout(timer);
        timer = null;
      } else if (timer == null) {
        poll();
      }
    }

    poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div className="admin-view" aria-busy={status === "loading"}>
      <header className="admin-head">
        <a className="admin-back" href="#/">← back</a>
        <h1>Activity</h1>
        <p className="admin-sub">owner-only · anonymous aggregates · live</p>
      </header>

      {status === "signedout" && (
        <div className="admin-empty">
          <p>Sign in as the owner to view activity.</p>
          <button type="button" className="btn" onClick={() => signIn()}>Sign in</button>
        </div>
      )}
      {status === "forbidden" && (
        <div className="admin-empty"><p>This dashboard is owner-only.</p></div>
      )}
      {status === "loading" && <AdminSkeleton />}
      {status === "error" && !data && (
        <div className="admin-empty"><p>Couldn't load activity. Retrying…</p></div>
      )}

      {data && (status === "ok" || status === "error") && (
        <Overview data={data} stale={status === "error"} />
      )}
    </div>
  );
}

function Overview({ data, stale }) {
  const turn = data.activeByTurn ?? { A: 0, B: 0, done: 0 };
  return (
    <>
      <div className="admin-tiles">
        <StatTile num={data.gamesInProgress} label="Games in progress" />
        <StatTile num={data.distinctActiveUsers} label="Signed-in players active" />
        <StatTile num={data.recentPairings} label="Recent pairings (30d)" />
      </div>

      <section className="admin-panel">
        <h2>Whose turn (active games)</h2>
        <div className="admin-turn">
          <span><b>{turn.A}</b> player A</span>
          <span><b>{turn.B}</b> player B</span>
          <span className="muted"><b>{turn.done}</b> resolving</span>
        </div>
      </section>

      <section className="admin-panel">
        <h2>Top choices in play</h2>
        <ChoiceBars choices={data.topChoicesInPlay ?? []} floor={data.choiceFloor} />
      </section>

      <p className="admin-foot">
        {stale ? "reconnecting… " : ""}
        updated {data.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : "—"}
      </p>
    </>
  );
}

function StatTile({ num, label }) {
  return (
    <div className="stat-tile">
      <div className="stat-num">{num ?? 0}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

// Single-series magnitude → one sequential hue (house --indigo), no legend,
// direct-labeled. Suppressed entirely below the k-anon floor.
function ChoiceBars({ choices, floor }) {
  if (!choices.length) {
    return (
      <p className="admin-hint">
        Nothing above the privacy floor yet (a choice must appear in ≥ {floor} active
        games to show).
      </p>
    );
  }
  const max = Math.max(...choices.map((c) => c.count));
  return (
    <div className="admin-bars">
      {choices.map((c) => (
        <div className="bar-row" key={c.label}>
          <span className="bar-label" title={c.label}>{c.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(c.count / max) * 100}%` }} />
          </span>
          <span className="bar-count">{c.count}</span>
        </div>
      ))}
    </div>
  );
}
