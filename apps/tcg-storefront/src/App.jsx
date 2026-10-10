import { Route, Routes, useParams } from "react-router-dom";

import StoreLayout from "./components/StoreLayout.jsx";
import CardPage from "./pages/CardPage.jsx";
import HomePage from "./pages/HomePage.jsx";
import LandingPage from "./pages/LandingPage.jsx";
import NotFoundPage from "./pages/NotFoundPage.jsx";
import SearchPage from "./pages/SearchPage.jsx";

// Keyed by slug so moving between stores starts a fresh layout (store info,
// cart) instead of carrying one store's cart into another's storage key.
function StoreRoute() {
  const { slug } = useParams();
  return <StoreLayout key={slug} slug={slug} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/s/:slug" element={<StoreRoute />}>
        <Route index element={<HomePage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="card/:oracleId" element={<CardPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
