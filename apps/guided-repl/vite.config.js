import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Local accounts API (services/guided-repl-api, `npm run dev` on :3001).
    // Prod serves /api/* through CloudFront; guided mode never requires it.
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
