import { Link } from "react-router-dom";
import { profile, experience, projects, skills } from "../data";
import "./resume.css";

export default function Resume() {
  return (
    <div className="resume-page">
      <div className="resume-toolbar no-print">
        <Link to="/">← Back</Link>
        <button onClick={() => window.print()}>Download PDF (Print → Save as PDF)</button>
      </div>

      <article className="resume">
        <header className="r-head">
          <h1>{profile.name}</h1>
          <p className="r-title">
            Senior Software Engineer · React + AWS · AI-native product development
          </p>
          <p className="r-contact">
            <a href={`mailto:${profile.email}`}>{profile.email}</a>
            <span>·</span>
            <a href={profile.links.github}>github.com/AustinJuliusKim</a>
            <span>·</span>
            <a href={profile.links.linkedin}>linkedin.com/in/austinjuliuskim</a>
            <span>·</span>
            <span>{profile.location}</span>
          </p>
        </header>

        <section className="r-section">
          <h2>Summary</h2>
          <p>
            Product-minded engineer with ~10 years shipping user-facing web software in React and
            AWS (Loot Crate, Ring/Amazon, Riot Games). Now building AI-native products on top of
            Claude — a learning platform that teaches Claude Code, and a live consumer app with
            Claude-powered features. Strong front-end craft, full-stack ownership, and 0→1 delivery.
          </p>
        </section>

        <section className="r-section">
          <h2>Experience</h2>
          {experience.map((job) => (
            <div className="r-job" key={job.company}>
              <div className="r-job-head">
                <span className="r-company">{job.company}</span>
                <span className="r-role">{job.role}</span>
                <span className="r-period">{job.period}</span>
              </div>
              <ul>
                {job.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>

        <section className="r-section">
          <h2>Selected Projects</h2>
          {projects.map((p) => (
            <div className="r-project" key={p.name}>
              <p className="r-proj-head">
                <strong>{p.name}</strong> — {p.tagline}{" "}
                {p.live && (
                  <a href={p.live}>{p.live.replace("https://", "")}</a>
                )}
              </p>
              <p className="r-proj-stack">{p.stack.join(" · ")}</p>
            </div>
          ))}
        </section>

        <section className="r-section">
          <h2>Skills</h2>
          {skills.map((g) => (
            <p className="r-skills" key={g.group}>
              <strong>{g.group}:</strong> {g.items.join(", ")}
            </p>
          ))}
        </section>

        <section className="r-section">
          <h2>Education</h2>
          <p className="r-edu">University of California, Irvine — B.A. Economics, 2012</p>
        </section>
      </article>
    </div>
  );
}
