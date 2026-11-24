import { forwardRef, useRef, useState } from "react";
import { mapFrame } from "../lib/geometry.js";

export const TEAM_HEX = { ally: "#60a5fa", enemy: "#ff4655" };
const AGENT_R = 26;
const ABILITY_R = 17;
const MIN_STEP = 4; // board units between freehand points
const MAX_POINTS = 600;
const FONT = "Inter, system-ui, sans-serif";

function arrowHead(points, size = 18) {
  const [x1, y1] = points[points.length - 2];
  const [x2, y2] = points[points.length - 1];
  const a = Math.atan2(y2 - y1, x2 - x1);
  const p = (da) => `${x2 - size * Math.cos(a + da)},${y2 - size * Math.sin(a + da)}`;
  return `${x2},${y2} ${p(0.45)} ${p(-0.45)}`;
}

function Token({ x, y, r, ring, icon, label }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <circle r={r + 3} fill={ring} />
      <circle r={r} fill="#0f1923" />
      {icon ? (
        <image href={icon} x={-r * 0.82} y={-r * 0.82} width={r * 1.64} height={r * 1.64} clipPath="url(#token-clip)" />
      ) : (
        <text textAnchor="middle" dy={r * 0.35} fontSize={r} fontWeight="700" fill="#ece8e1" fontFamily={FONT}>{label}</text>
      )}
    </g>
  );
}

function Item({ item, agentById }) {
  switch (item.type) {
    case "agent": {
      const agent = agentById.get(item.agentId);
      return <Token x={item.x} y={item.y} r={AGENT_R} ring={TEAM_HEX[item.team]} icon={agent?.icon} label={agent?.name?.[0] ?? "?"} />;
    }
    case "ability": {
      const ability = agentById.get(item.agentId)?.abilities.find((a) => a.slot === item.slot);
      return <Token x={item.x} y={item.y} r={ABILITY_R} ring={TEAM_HEX[item.team]} icon={ability?.icon} label="•" />;
    }
    case "path": {
      const pts = item.points.map((p) => p.join(",")).join(" ");
      return (
        <g>
          <polyline points={pts} fill="none" stroke="transparent" strokeWidth="22" strokeLinecap="round" />
          <polyline points={pts} fill="none" stroke={item.color} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          {item.arrow && <polygon points={arrowHead(item.points)} fill={item.color} />}
        </g>
      );
    }
    case "circle":
      return <circle cx={item.x} cy={item.y} r={item.r} fill={item.color} fillOpacity="0.25" stroke={item.color} strokeWidth="3" />;
    case "text":
      return (
        <text x={item.x} y={item.y} textAnchor="middle" fontSize="28" fontWeight="700" fontFamily={FONT}
          fill={item.color} stroke="#0f1923" strokeWidth="6" paintOrder="stroke">
          {item.text}
        </text>
      );
    default:
      return null;
  }
}

// Rough bounds for the selection outline.
function bounds(item) {
  switch (item.type) {
    case "agent": return { x: item.x - AGENT_R - 6, y: item.y - AGENT_R - 6, w: (AGENT_R + 6) * 2, h: (AGENT_R + 6) * 2 };
    case "ability": return { x: item.x - ABILITY_R - 6, y: item.y - ABILITY_R - 6, w: (ABILITY_R + 6) * 2, h: (ABILITY_R + 6) * 2 };
    case "circle": return { x: item.x - item.r - 4, y: item.y - item.r - 4, w: item.r * 2 + 8, h: item.r * 2 + 8 };
    case "text": {
      const w = Math.max(30, item.text.length * 16);
      return { x: item.x - w / 2 - 6, y: item.y - 30, w: w + 12, h: 40 };
    }
    default: {
      const xs = item.points.map((p) => p[0]);
      const ys = item.points.map((p) => p[1]);
      const x = Math.min(...xs) - 10;
      const y = Math.min(...ys) - 10;
      return { x, y, w: Math.max(...xs) - x + 10, h: Math.max(...ys) - y + 10 };
    }
  }
}

const BoardCanvas = forwardRef(function BoardCanvas(
  { map, items, agentById, tool, stamp, team, color, selectedId, onSelect, onAction },
  svgRef,
) {
  const frame = mapFrame(map);
  const [drag, setDrag] = useState(null); // { id, start, dx, dy }
  const [draft, setDraft] = useState(null); // in-progress drawing
  const startRef = useRef(null);

  const toBoard = (e) => {
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    return [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];
  };

  const capture = (e) => svgRef.current.setPointerCapture?.(e.pointerId);

  const onItemDown = (e, item) => {
    if (tool === "erase") {
      e.stopPropagation();
      onAction({ type: "remove", id: item.id });
      if (selectedId === item.id) onSelect(null);
      return;
    }
    if (tool !== "select") return; // drawing tools draw over items
    e.stopPropagation();
    onSelect(item.id);
    capture(e);
    setDrag({ id: item.id, start: toBoard(e), dx: 0, dy: 0 });
  };

  const onDown = (e) => {
    if (e.button !== 0) return;
    const p = toBoard(e);
    startRef.current = p;
    if (tool === "select" || tool === "erase") {
      onSelect(null);
    } else if (tool === "stamp" && stamp) {
      onAction({ type: "add", item: { ...stamp, team, x: p[0], y: p[1] } });
    } else if (tool === "text") {
      onAction({ type: "add", item: { type: "text", x: p[0], y: p[1], text: "Text", color } }, { selectNew: true });
    } else if (tool === "pen" || tool === "arrow" || tool === "circle") {
      capture(e);
      setDraft({ tool, points: [p, p] });
    }
  };

  const onMove = (e) => {
    if (drag) {
      const [x, y] = toBoard(e);
      setDrag({ ...drag, dx: x - drag.start[0], dy: y - drag.start[1] });
    } else if (draft) {
      const p = toBoard(e);
      if (draft.tool === "pen") {
        const last = draft.points[draft.points.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= MIN_STEP && draft.points.length < MAX_POINTS) {
          setDraft({ ...draft, points: [...draft.points, p] });
        }
      } else {
        setDraft({ ...draft, points: [draft.points[0], p] });
      }
    }
  };

  const onUp = () => {
    if (drag) {
      onAction({ type: "move", id: drag.id, dx: Math.round(drag.dx * 10) / 10, dy: Math.round(drag.dy * 10) / 10 });
      setDrag(null);
    }
    if (draft) {
      const [a, b] = [draft.points[0], draft.points[draft.points.length - 1]];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (draft.tool === "circle") {
        onAction({ type: "add", item: { type: "circle", x: a[0], y: a[1], r: Math.round(Math.max(length, 30)), color } });
      } else if (draft.tool === "arrow" && length > 12) {
        onAction({ type: "add", item: { type: "path", points: [a, b], color, arrow: true } });
      } else if (draft.tool === "pen" && draft.points.length > 2) {
        onAction({ type: "add", item: { type: "path", points: draft.points.slice(1), color, arrow: false } });
      }
      setDraft(null);
    }
  };

  const selected = items.find((i) => i.id === selectedId);
  const sel = selected && bounds(selected);
  const offset = (item) => (drag?.id === item.id ? `translate(${drag.dx} ${drag.dy})` : undefined);

  return (
    <svg
      ref={svgRef}
      className={`board-canvas tool-${tool}`}
      viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      role="application"
      aria-label={`${map.name} planner board`}
    >
      <defs>
        <clipPath id="token-clip" clipPathUnits="objectBoundingBox">
          <circle cx="0.5" cy="0.5" r="0.5" />
        </clipPath>
      </defs>
      <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} fill="#121e29" />
      <image href={map.minimap} x="0" y="0" width="1000" height="1000" opacity="0.92" />

      {items.map((item) => (
        <g key={item.id} transform={offset(item)} onPointerDown={(e) => onItemDown(e, item)} className="board-item">
          <Item item={item} agentById={agentById} />
        </g>
      ))}

      {draft && (draft.tool === "circle" ? (
        <circle
          cx={draft.points[0][0]} cy={draft.points[0][1]}
          r={Math.hypot(draft.points[1][0] - draft.points[0][0], draft.points[1][1] - draft.points[0][1])}
          fill={color} fillOpacity="0.2" stroke={color} strokeWidth="3" strokeDasharray="8 6"
        />
      ) : (
        <Item item={{ type: "path", points: draft.points, color, arrow: draft.tool === "arrow" }} agentById={agentById} />
      ))}

      {sel && (
        <rect
          data-ui="selection"
          x={sel.x} y={sel.y} width={sel.w} height={sel.h} rx="6"
          transform={offset(selected)}
          fill="none" stroke="#ece8e1" strokeWidth="2" strokeDasharray="6 5" pointerEvents="none"
        />
      )}
    </svg>
  );
});

export default BoardCanvas;
