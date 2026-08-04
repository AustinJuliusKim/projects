import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useState } from "react";

import CardPage from "./pages/CardPage.jsx";
import DeckPage from "./pages/DeckPage.jsx";
import SearchPage from "./pages/SearchPage.jsx";

export default function App() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  function submit(e) {
    e.preventDefault();
    navigate(`/?q=${encodeURIComponent(q)}`);
  }

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          MTG DB
        </Link>
        <form onSubmit={submit} className="topbar-search">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search cards…"
            aria-label="Search cards"
          />
        </form>
        <nav>
          <NavLink to="/deck">Deck</NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<SearchPage />} />
          <Route path="/card/:oracleId" element={<CardPage />} />
          <Route path="/deck" element={<DeckPage />} />
        </Routes>
      </main>
      <footer className="attribution">
        Card data © Wizards of the Coast, provided by{" "}
        <a href="https://scryfall.com">Scryfall</a>. Unofficial Fan Content permitted under the
        Wizards of the Coast Fan Content Policy; not endorsed by Scryfall or Wizards of the Coast.
      </footer>
    </div>
  );
}
