import { projects, mtgAttribution, type Project } from "../data";

const STATUS_LABEL: Record<Project["status"], string> = {
  live: "Live",
  "in-progress": "In progress",
};

export default function Work() {
  const showsMtgData = projects.some((p) => p.name.startsWith("MTG"));

  return (
    <section id="work" aria-labelledby="work-h">
      <div className="wrap">
        <p className="eyebrow">Selected work</p>
        <h2 id="work-h" style={{ margin: "0 0 28px", fontSize: "1.6rem" }}>
          Things I designed, built, and shipped.
        </h2>
        {projects.map((p) => (
          <article className="project" key={p.name}>
            <h3>
              {p.name}
              <span className={`badge badge--${p.status}`}>
                {STATUS_LABEL[p.status]}
              </span>
            </h3>
            <p className="p-tag">{p.tagline}</p>
            {p.statusNote && <p className="p-status-note">{p.statusNote}</p>}
            <p className="desc">{p.description}</p>
            <ul>
              {p.highlights.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
            <dl className="spec">
              {p.spec.map((row) => (
                <div className="spec-row" key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            <div className="p-links">
              {/* Only link what someone can actually visit today. */}
              {p.status === "live" && p.live && (
                <a href={p.live} target="_blank" rel="noreferrer">
                  Live ↗
                </a>
              )}
              {p.source && (
                <a href={p.source} target="_blank" rel="noreferrer">
                  Source ↗
                </a>
              )}
            </div>
          </article>
        ))}
        {showsMtgData && <p className="attribution">{mtgAttribution}</p>}
      </div>
    </section>
  );
}
