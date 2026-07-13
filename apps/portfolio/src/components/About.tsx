import { about } from "../data";

export default function About() {
  return (
    <section id="about" className="about" aria-labelledby="about-h">
      <div className="wrap">
        <p className="eyebrow">About</p>
        <h2 id="about-h" style={{ margin: "0 0 24px", fontSize: "1.6rem" }}>
          Product-minded engineer, front-end roots, building on Claude.
        </h2>
        {about.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    </section>
  );
}
