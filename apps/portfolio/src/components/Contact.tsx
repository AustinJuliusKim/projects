import { profile } from "../data";

export default function Contact() {
  return (
    <section id="contact" className="contact" aria-labelledby="contact-h">
      <div className="wrap">
        <p className="eyebrow">Contact</p>
        <h2 id="contact-h">Let's talk.</h2>
        <p style={{ color: "var(--text-muted)", margin: 0, maxWidth: "46ch" }}>
          I'm looking for AI engineering roles — building products on top of LLMs, and the
          full-stack systems around them. The fastest way to reach me is email.
        </p>
        <div className="cta-row">
          <a className="btn primary" href={`mailto:${profile.email}`}>
            {profile.email}
          </a>
          <a className="btn" href={profile.links.github} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
          <a className="btn" href={profile.links.linkedin} target="_blank" rel="noreferrer">
            LinkedIn ↗
          </a>
        </div>
      </div>
    </section>
  );
}
