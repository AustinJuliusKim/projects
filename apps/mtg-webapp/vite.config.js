import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // Local API (services/mtg-api, `python scripts/serve-local.py` on :8000)
    // serves routes at /v1/* — strip the /api prefix the app uses in prod
    // (where CloudFront forwards /api/* and Mangum strips it).
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
