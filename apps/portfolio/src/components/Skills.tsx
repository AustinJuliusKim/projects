import { skills } from "../data";

export default function Skills() {
  return (
    <section id="skills" aria-labelledby="skills-h">
      <div className="wrap">
        <p className="eyebrow">Skills</p>
        <h2 id="skills-h" style={{ margin: "0 0 28px", fontSize: "1.6rem" }}>
          What I work with.
        </h2>
        {skills.map((g) => (
          <div className="skillgroup" key={g.group}>
            <h3>{g.group}</h3>
            <div className="chips">
              {g.items.map((s) => (
                <span className="chip" key={s}>
                  {s}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
