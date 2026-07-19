import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/health": "http://127.0.0.1:8787",
      "/plans": "http://127.0.0.1:8787",
      "/sessions": "http://127.0.0.1:8787",
      "/agents": {
        target: "http://127.0.0.1:8787",
        ws: true,
      },
    },
  },
});
