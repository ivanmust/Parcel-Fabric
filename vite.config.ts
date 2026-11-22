import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const apiTarget = env.API_URL || "http://127.0.0.1:4001";
  return {
    plugins: [react()],
    // The ArcGIS SDK and map components are native ES modules that load most of their code on
    // demand (snapping, sketch, editor workflows...). Pre-bundling them made Vite discover new
    // entry points mid-session and invalidate its cache ("504 Outdated Optimize Dep"), which
    // broke drawing while editing. Serving them unbundled avoids that.
    // Calcite is excluded too: the map components import it (and Lit) unbundled, so a pre-bundled
    // copy would load Calcite and Lit twice ("Multiple versions of Lit loaded").
    optimizeDeps: {
      exclude: ["@arcgis/core", "@arcgis/map-components", "@esri/calcite-components"],
    },
    server: {
      port: 5174,
      strictPort: true,
      proxy: { "/api": { target: apiTarget, changeOrigin: false } },
    },
    preview: { port: 5174, proxy: { "/api": { target: apiTarget } } },
    build: {
      target: "es2022",
      chunkSizeWarningLimit: 4000,
      sourcemap: true,
    },
  };
});
