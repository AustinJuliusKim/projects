import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  // A production build without Cognito env refuses to start (src/session.js
  // authConfig): say so at build time too, not only in the browser.
  if (command === "build" && !(env.VITE_COGNITO_DOMAIN && env.VITE_COGNITO_CLIENT_ID)) {
    console.warn(
      "\n[tcg-pos] VITE_COGNITO_DOMAIN / VITE_COGNITO_CLIENT_ID are not set: this build " +
        "will show a configuration error instead of a sign-in screen.\n",
    );
  }
  return {
    plugins: [react()],
    server: {
      // Local API (services/tcg-pos-api, `make serve-dev` on :8001) serves
      // routes at /v1/* — strip the /api prefix the app uses (same-origin
      // /api in prod, matching mtg-webapp; Mangum strips it there).
      proxy: {
        "/api": {
          target: "http://127.0.0.1:8001",
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
  };
});
