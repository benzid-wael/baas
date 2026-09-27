import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
    ],
    /**
     * The portal runs in a browser, so its tests need a DOM (MP-6). Everything
     * else keeps the default Node environment — loading jsdom for a migration
     * test would cost seconds per file and buy nothing.
     */
    environmentMatchGlobs: [["apps/portal/**", "jsdom"]],
    // A no-op outside jsdom, so it costs the Node suites nothing.
    setupFiles: ["apps/portal/src/test-setup.ts"],
    coverage: {
      provider: "v8",
      include: [
        "packages/*/src/**/*.ts",
        "apps/*/src/**/*.ts",
        "apps/*/src/**/*.tsx",
      ],
      // index.ts re-exports and ports.ts declares interfaces: neither has
      // executable code, and both report as 0% rather than as absent.
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/index.ts",
        "**/ports.ts",
        // Ambient declarations only; there is nothing to execute.
        "**/vite-env.d.ts",
        "**/test-setup.ts",
      ],
      reporter: ["text", "lcov"],
      // Definition of Done: 70% or higher, and never decreasing.
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
