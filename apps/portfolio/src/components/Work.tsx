import { projects } from "../data";

export default function Work() {
  return (
    <section id="work" aria-labelledby="work-h">
      <div className="wrap">
        <p className="eyebrow">Selected work</p>
        <h2 id="work-h" style={{ margin: "0 0 28px", fontSize: "1.6rem" }}>
          Things I designed, built, and shipped.
        </h2>
        {projects.map((p) => (
          <article className="project" key={p.name}>
            <h3>{p.name}</h3>
            <p className="p-tag">{p.tagline}</p>
            <p className="desc">{p.description}</p>
            <ul>
              {p.highlights.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
            <div className="chips">
              {p.stack.map((s) => (
                <span className="chip" key={s}>
                  {s}
                </span>
              ))}
            </div>
            <div className="p-links">
              {p.live && (
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
      </div>
    </section>
  );
}
