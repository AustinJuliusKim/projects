import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// No API proxy: v1 has no server. The browser talks to S3 directly with
// scoped Cognito credentials, so there is nothing to forward in dev.
export default defineConfig({
  plugins: [react()],
});
