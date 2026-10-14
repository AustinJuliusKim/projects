import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // Local API (services/tcg-pos-api, `make serve` on :8001) serves routes
    // at /v1/* — strip the /api prefix the app uses (same-origin /api in prod,
    // matching mtg-webapp; Mangum strips it there).
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8001",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
