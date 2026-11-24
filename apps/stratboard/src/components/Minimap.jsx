import { spawns } from "../lib/geometry.js";

export const ROLE_COLORS = {
  Duelist: "var(--duelist)",
  Controller: "var(--controller)",
  Initiator: "var(--initiator)",
  Sentinel: "var(--sentinel)",
};

const S = 1000; // SVG units across the minimap
const R = 24; // player marker radius

// Players sharing a callout fan out in a small ring so none hide the others.
function layoutMarkers(players) {
  const groups = new Map();
  players.forEach((p, i) => {
    const key = p.at.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  const out = [];
  for (const idx of groups.values()) {
    idx.forEach((i, k) => {
      const p = players[i];
      const spread = idx.length > 1 ? R * 1.25 : 0;
      const angle = (k / idx.length) * Math.PI * 2 - Math.PI / 2;
      out[i] = { x: p.at.x * S + Math.cos(angle) * spread, y: p.at.y * S + Math.sin(angle) * spread };
    });
  }
  return out;
}

// Minimap art fills only the middle of its image, so frame the callouts
// (plus a margin) instead of the whole square.
function frame(map) {
  const xs = map.callouts.map((c) => c.x * S);
  const ys = map.callouts.map((c) => c.y * S);
  const pad = 70;
  const x0 = Math.max(0, Math.min(...xs) - pad);
  const y0 = Math.max(0, Math.min(...ys) - pad);
  const w = Math.min(S, Math.max(...xs) + pad) - x0;
  const h = Math.min(S, Math.max(...ys) + pad) - y0;
  return `${x0} ${y0} ${w} ${h}`;
}

export default function Minimap({ map, plan, active, onActive }) {
  const markers = layoutMarkers(plan.players);
  const { attack, defense } = spawns(map);
  const siteLabel = map.callouts.find((c) => c.name === `${plan.site} Site`);
  const targets = [...new Map(
    plan.players
      .filter((p) => p.target && p.target.name !== p.at.name)
      .map((p) => [p.target.name, p.target]),
  ).values()];

  return (
    <svg className="minimap" viewBox={frame(map)} role="img" aria-label={`${map.name} minimap with the plan`}>
      <defs>
        <clipPath id="agent-clip" clipPathUnits="objectBoundingBox">
          <circle cx="0.5" cy="0.5" r="0.5" />
        </clipPath>
      </defs>
      <image href={map.minimap} x="0" y="0" width={S} height={S} className="minimap-img" />

      {[["ATK", attack], ["DEF", defense]].map(([label, c]) => (
        <g key={label} className="spawn" transform={`translate(${c.x * S} ${c.y * S})`}>
          <rect x="-24" y="-13" width="48" height="26" rx="4" />
          <text textAnchor="middle" dy="5">{label}</text>
        </g>
      ))}

      {siteLabel && (
        <circle className="site-ring" cx={siteLabel.x * S} cy={siteLabel.y * S} r="62" />
      )}

      {plan.players.map((p, i) =>
        p.target && p.target.name !== p.at.name ? (
          <line
            key={`l${i}`}
            className={`route ${active === i ? "is-active" : ""}`}
            x1={markers[i].x} y1={markers[i].y}
            x2={p.target.x * S} y2={p.target.y * S}
            stroke={ROLE_COLORS[p.role]}
          />
        ) : null,
      )}

      {targets.map((t) => (
        <g key={t.name} className="target" transform={`translate(${t.x * S} ${t.y * S})`}>
          <circle r="16" />
          <text textAnchor="middle" y="-24">{t.name}</text>
        </g>
      ))}

      {plan.players.map((p, i) => (
        <g
          key={p.agentId}
          className={`marker ${active === i ? "is-active" : ""}`}
          transform={`translate(${markers[i].x} ${markers[i].y})`}
          onMouseEnter={() => onActive(i)}
          onMouseLeave={() => onActive(null)}
        >
          <circle r={R + 3} fill={ROLE_COLORS[p.role]} />
          <circle r={R} className="marker-bg" />
          {p.icon && (
            <image href={p.icon} x={-R} y={-R} width={R * 2} height={R * 2} clipPath="url(#agent-clip)" />
          )}
          <g transform={`translate(${R - 2} ${-R + 2})`}>
            <circle r="11" className="badge" />
            <text textAnchor="middle" dy="4.5" className="badge-text">{i + 1}</text>
          </g>
          <title>{`${i + 1}. ${p.agent} at ${p.at.name}`}</title>
        </g>
      ))}
    </svg>
  );
}
