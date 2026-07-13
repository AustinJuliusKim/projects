import { profile } from "../data";

export default function Hero() {
  return (
    <header className="hero" id="top">
      <div className="wrap">
        <p className="eyebrow">Software Engineer</p>
        <h1>{profile.tagline}</h1>
        <p className="lede">{profile.subtitle}</p>
        <p className="meta">{profile.location}</p>
        <div className="cta-row">
          <a className="btn primary" href="#work">
            View work
          </a>
          <a className="btn" href="/resume">
            Résumé
          </a>
          <a className="btn" href={`mailto:${profile.email}`}>
            Get in touch
          </a>
        </div>
      </div>
    </header>
  );
}
