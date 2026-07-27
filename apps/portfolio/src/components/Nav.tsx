import { profile } from "../data";

export default function Nav() {
  return (
    <nav className="nav" aria-label="Primary">
      <div className="wrap">
        <a href="/#top" className="brand">
          {profile.name}
        </a>
        <div className="navlinks">
          {/* Root-relative anchors so these still work from /blog and /blog/:slug.
              On the home page the browser treats them as a hash change and scrolls. */}
          <a href="/#work">Work</a>
          <a href="/#about" className="hide-sm">
            About
          </a>
          <a href="/blog">Blog</a>
          <a href="/resume">Résumé</a>
          <a href={`mailto:${profile.email}`} className="hide-sm">
            Contact
          </a>
        </div>
      </div>
    </nav>
  );
}
