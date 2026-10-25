import { simBuildId } from "../../scripts/sim-build";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const port = Number(process.env.WEB_PORT ?? process.env.PORT ?? 5173);
const api = process.env.API_ORIGIN ?? "http://127.0.0.1:3320";
export default defineConfig({
  define: { "import.meta.env.VITE_SIM_BUILD_ID": JSON.stringify(simBuildId()) },
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  server: { port, strictPort: true, proxy: { "/api": { target: api, changeOrigin: false } } },
  preview: { port, strictPort: true, proxy: { "/api": { target: api, changeOrigin: false } } },
  build: { outDir: process.env.WEB_DIST_DIR ?? "dist" },
});
