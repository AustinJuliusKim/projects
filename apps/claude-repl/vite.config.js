import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Proxy the WS connection to the backend in dev so the browser talks to
    // a same-origin /ws and we avoid CORS during local development.
    proxy: {
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
