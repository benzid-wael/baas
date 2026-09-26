import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      // index.ts re-exports and ports.ts declares interfaces: neither has
      // executable code, and both report as 0% rather than as absent.
      exclude: ["**/*.test.ts", "**/index.ts", "**/ports.ts"],
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
