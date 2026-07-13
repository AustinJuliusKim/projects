import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static SPA. CloudFront serves index.html for unknown routes (403/404 → /index.html),
// so client-side routes like /resume resolve on hard refresh.
export default defineConfig({
  plugins: [react()],
});
