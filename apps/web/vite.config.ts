import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = process.env.PARLEY_SERVER ?? "http://localhost:3000";

// In development the browser talks to Vite only; it forwards API and WebSocket traffic to the
// server, so there's no CORS to configure.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: server, rewrite: (path) => path.replace(/^\/api/, "") },
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
});
