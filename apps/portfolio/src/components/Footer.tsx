import { profile } from "../data";

export default function Footer() {
  return (
    <footer>
      <div className="wrap">
        © {new Date().getFullYear()} {profile.name} · Built with React + Vite, deployed on AWS.
      </div>
    </footer>
  );
}
