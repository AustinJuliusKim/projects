import { profile } from "../data";

export default function Nav() {
  return (
    <nav className="nav" aria-label="Primary">
      <div className="wrap">
        <a href="#top" className="brand">
          {profile.name}
        </a>
        <div className="navlinks">
          <a href="#work">Work</a>
          <a href="#about" className="hide-sm">
            About
          </a>
          <a href="/resume">Résumé</a>
          <a href={`mailto:${profile.email}`}>Contact</a>
        </div>
      </div>
    </nav>
  );
}
