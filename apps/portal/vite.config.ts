import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The portal is a static bundle. It holds no secret and talks to `baas` over
 * the same API an operator's browser does — there is no server-side rendering
 * step and no Node process, which is what lets the boundary gate refuse
 * `@baas/platform` outright.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
  server: { port: 5173 },
});
