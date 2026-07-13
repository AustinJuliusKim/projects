import Nav from "../components/Nav";
import Hero from "../components/Hero";
import About from "../components/About";
import Work from "../components/Work";
import Skills from "../components/Skills";
import Contact from "../components/Contact";
import { profile } from "../data";

export default function Home() {
  return (
    <>
      <a className="skip" href="#work">
        Skip to work
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <About />
        <Work />
        <Skills />
        <Contact />
      </main>
      <footer>
        <div className="wrap">
          © {new Date().getFullYear()} {profile.name} · Built with React + Vite, deployed on AWS.
        </div>
      </footer>
    </>
  );
}
