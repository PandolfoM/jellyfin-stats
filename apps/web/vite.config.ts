import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Proxying keeps dev same-origin, so the httpOnly session cookie behaves
    // exactly as it does in production. A cross-origin dev setup would need
    // CORS plus SameSite=None, which is a different security posture than
    // the one the API was built for.
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: false } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
