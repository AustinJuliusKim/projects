import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    // Local API (services/tcg-pos-api, `make serve` on :8001) serves routes
    // at /v1/* — strip the /api prefix the app uses (same-origin /api in
    // prod, matching apps/tcg-pos and mtg-webapp).
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8001",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  preview: { port: 5175 },
  build: {
    rollupOptions: {
      output: {
        // Vendor code changes rarely; keep it out of the app chunk so a
        // deploy doesn't bust its cache.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/@mantine/") || id.includes("/@floating-ui/")) return "mantine";
          return "vendor";
        },
      },
    },
  },
});
