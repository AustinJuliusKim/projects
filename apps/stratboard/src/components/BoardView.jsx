import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  COLORS, blankBoard, cleanBoard, createHistory, decodeBoard, encodeBoard, history,
} from "../lib/board.js";
import BoardCanvas, { TEAM_HEX } from "./BoardCanvas.jsx";
import Segmented from "./Segmented.jsx";
import { exportPng } from "./exportPng.js";

const DRAFT_KEY = "stratboard.board";

const TOOLS = [
  ["select", "Move", "V"],
  ["pen", "Draw", "D"],
  ["arrow", "Arrow", "A"],
  ["circle", "Area", "C"],
  ["text", "Text", "T"],
  ["erase", "Erase", "E"],
];

function loadDraft(mapIds) {
  try {
    return cleanBoard(JSON.parse(localStorage.getItem(DRAFT_KEY)), mapIds);
  } catch {
    return null;
  }
}

function TextField({ value, onCommit, ...rest }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => text !== value && onCommit(text);
  return (
    <input
      {...rest}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { setText(value); e.currentTarget.blur(); }
      }}
    />
  );
}

export default function BoardView({ data, state, setState, incoming }) {
  const { maps, agents } = data;
  const mapIds = useMemo(() => maps.map((m) => m.id), [maps]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const [h, dispatch] = useReducer(history, null, () =>
    createHistory(incoming ?? loadDraft(mapIds) ?? blankBoard(maps[0].id)));
  const board = h.present;
  const [stepIndex, setStepIndex] = useState(0);
  const step = Math.min(stepIndex, board.steps.length - 1);
  const items = board.steps[step].items;

  const [tool, setTool] = useState("select");
  const [stamp, setStamp] = useState(null);
  const [team, setTeam] = useState("ally");
  const [color, setColor] = useState(COLORS[0]);
  const [selectedId, setSelectedId] = useState(null);
  const [pickedAgent, setPickedAgent] = useState(null);
  const [status, setStatus] = useState("");
  const svgRef = useRef(null);
  const textRef = useRef(null);

  const act = (action, { selectNew = false } = {}) => {
    if (selectNew) {
      setSelectedId(`i${board.nextId}`);
      setTool("select");
      setTimeout(() => textRef.current?.select(), 0);
    }
    dispatch({ step, ...action });
  };

  const flash = (msg) => {
    setStatus(msg);
    setTimeout(() => setStatus(""), 1800);
  };

  // A shared link replaces the board once decoded, then drops out of the URL
  // so later edits aren't shadowed by a stale code.
  useEffect(() => {
    if (!state.d) return;
    let cancelled = false;
    decodeBoard(state.d, mapIds).then((shared) => {
      if (cancelled) return;
      if (shared) {
        dispatch({ type: "reset", board: shared });
        setStepIndex(0);
      } else {
        flash("That share link couldn't be read.");
      }
      setState({ view: "board", d: null }, { replace: true });
    });
    return () => { cancelled = true; };
  }, [state.d]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(board)); } catch { /* storage blocked */ }
    }, 300);
    return () => clearTimeout(t);
  }, [board]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest("input, select, textarea")) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        dispatch({ type: "remove", step, id: selectedId });
        setSelectedId(null);
      } else if (e.key === "Escape") {
        setSelectedId(null);
        setTool("select");
      } else if (!mod) {
        const hit = TOOLS.find(([, , key]) => key.toLowerCase() === e.key.toLowerCase());
        if (hit) setTool(hit[0]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, step]);

  const map = maps.find((m) => m.id === board.map) ?? maps[0];
  const selected = items.find((i) => i.id === selectedId);

  const chooseStamp = (next) => {
    setStamp(next);
    setTool("stamp");
    setSelectedId(null);
  };

  const share = async () => {
    const code = await encodeBoard(board);
    const url = `${window.location.origin}${window.location.pathname}#board?d=${code}`;
    try {
      await navigator.clipboard.writeText(url);
      flash("Link copied");
    } catch {
      flash("Couldn't reach the clipboard");
    }
  };

  const download = async () => {
    try {
      const name = `${map.name}-${board.steps[step].name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      await exportPng(svgRef.current, `${name}.png`);
    } catch (err) {
      console.error(err);
      flash("Export failed");
    }
  };

  const goStep = (i) => {
    setStepIndex(i);
    setSelectedId(null);
  };

  return (
    <div className="board-layout">
      <aside className="panel board-side" aria-label="Board tools">
        <label className="field">
          <span className="field-label">Map</span>
          <select value={board.map} onChange={(e) => { dispatch({ type: "setMap", map: e.target.value }); goStep(0); }}>
            {maps.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>

        <div className="field">
          <span className="field-label">Tool</span>
          <div className="tool-grid">
            {TOOLS.map(([key, label, shortcut]) => (
              <button
                key={key} type="button"
                className={`tool ${tool === key ? "is-on" : ""}`}
                aria-pressed={tool === key}
                title={`${label} (${shortcut})`}
                onClick={() => setTool(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">Color</span>
          <div className="swatches">
            {COLORS.map((c) => (
              <button
                key={c} type="button" className={`swatch ${color === c ? "is-on" : ""}`}
                style={{ background: c }} aria-label={`Color ${c}`} aria-pressed={color === c}
                onClick={() => {
                  setColor(c);
                  if (selected && "color" in selected) act({ type: "update", id: selected.id, patch: { color: c } });
                }}
              />
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">Place for</span>
          <Segmented value={team} onChange={setTeam} options={[["ally", "Allies"], ["enemy", "Enemies"]]} />
        </div>

        <div className="field">
          <span className="field-label">Agents</span>
          <div className="agent-grid">
            {agents.map((a) => (
              <button
                key={a.id} type="button" title={`${a.name} (${a.role})`}
                className={`agent-pick ${stamp?.type === "agent" && stamp.agentId === a.id && tool === "stamp" ? "is-on" : ""}`}
                style={{ "--ring": TEAM_HEX[team] }}
                onClick={() => { setPickedAgent(a.id); chooseStamp({ type: "agent", agentId: a.id }); }}
              >
                <img src={a.icon} alt={a.name} width="36" height="36" loading="lazy" />
              </button>
            ))}
          </div>
        </div>

        {pickedAgent && agentById.get(pickedAgent) && (
          <div className="field">
            <span className="field-label">{agentById.get(pickedAgent).name} abilities</span>
            <div className="ability-picks">
              {agentById.get(pickedAgent).abilities.map((ab) => (
                <button
                  key={ab.slot} type="button"
                  className={`ability-pick ${stamp?.type === "ability" && stamp.agentId === pickedAgent && stamp.slot === ab.slot && tool === "stamp" ? "is-on" : ""}`}
                  onClick={() => chooseStamp({ type: "ability", agentId: pickedAgent, slot: ab.slot })}
                >
                  {ab.icon && <img src={ab.icon} alt="" width="18" height="18" />}
                  {ab.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>

      <section className="panel board-main" aria-label="Board">
        <div className="board-toolbar">
          <div className="steps" role="tablist" aria-label="Steps">
            {board.steps.map((s, i) => (
              i === step ? (
                <TextField
                  key={i} className="step-tab is-on" aria-label="Step name" value={s.name}
                  onCommit={(name) => act({ type: "renameStep", name: name.trim() || s.name })}
                />
              ) : (
                <button key={i} type="button" role="tab" className="step-tab" onClick={() => goStep(i)}>{s.name}</button>
              )
            ))}
            <button type="button" className="step-add" title="Add a step (copies this one)"
              onClick={() => { act({ type: "addStep" }); goStep(step + 1); }}>+ Step</button>
            {board.steps.length > 1 && (
              <button type="button" className="step-add" title="Delete this step"
                onClick={() => { act({ type: "removeStep" }); goStep(Math.max(0, step - 1)); }}>Delete step</button>
            )}
          </div>
          <div className="board-actions">
            <button type="button" className="btn-ghost" disabled={!h.past.length} onClick={() => dispatch({ type: "undo" })} title="Undo (Ctrl+Z)">Undo</button>
            <button type="button" className="btn-ghost" disabled={!h.future.length} onClick={() => dispatch({ type: "redo" })} title="Redo (Ctrl+Shift+Z)">Redo</button>
            <button type="button" className="btn-ghost" disabled={!items.length} onClick={() => { act({ type: "clear" }); setSelectedId(null); }}>Clear</button>
            <button type="button" className="btn-ghost" onClick={download}>PNG</button>
            <button type="button" className="btn-primary btn-small" onClick={share}>Share</button>
          </div>
        </div>

        <BoardCanvas
          ref={svgRef}
          map={map} items={items} agentById={agentById}
          tool={tool} stamp={stamp} team={team} color={color}
          selectedId={selectedId} onSelect={setSelectedId} onAction={act}
        />

        <div className="board-foot">
          {selected ? (
            <div className="selection">
              <span className="field-label">Selected</span>
              {selected.type === "text" && (
                <TextField
                  ref={textRef} className="selection-text" aria-label="Text" maxLength={120} value={selected.text}
                  onCommit={(text) => text.trim() && act({ type: "update", id: selected.id, patch: { text: text.trim() } })}
                />
              )}
              {(selected.type === "agent" || selected.type === "ability") && (
                <>
                  <span>{agentById.get(selected.agentId)?.name ?? selected.agentId}</span>
                  <button type="button" className="btn-ghost"
                    onClick={() => act({ type: "update", id: selected.id, patch: { team: selected.team === "ally" ? "enemy" : "ally" } })}>
                    {selected.team === "ally" ? "Make enemy" : "Make ally"}
                  </button>
                </>
              )}
              {selected.type === "path" && (
                <label className="check">
                  <input type="checkbox" checked={selected.arrow}
                    onChange={(e) => act({ type: "update", id: selected.id, patch: { arrow: e.target.checked } })} />
                  Arrowhead
                </label>
              )}
              <button type="button" className="btn-ghost" onClick={() => { act({ type: "remove", id: selected.id }); setSelectedId(null); }}>Delete</button>
            </div>
          ) : (
            <p className="muted">
              {tool === "stamp" ? "Click the map to place. Esc to stop." : "Pick an agent or a tool. Drag items with Move. Del removes, Ctrl+Z undoes."}
            </p>
          )}
          {status && <span className="status" role="status">{status}</span>}
        </div>
      </section>
    </div>
  );
}
