import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Resolve every workspace package to its **source** during a test run (New-20).
 *
 * The published `exports` point at `dist`, which is right for a consumer and
 * wrong for coverage: `apps/e2e` imports `@baas/api`, v8 attributes the lines
 * to the built output, and `composition.ts` reported 0% while eleven tests ran
 * through it. The risk was never the number — it is that the number gets
 * quoted, and somebody eventually writes duplicate unit tests to "fix" a
 * well-tested file, or skips a genuinely untested one because the report is
 * noise either way.
 *
 * Aliased here rather than by adding a conditional export to each manifest.
 * The boundary gate reads those manifests, and a package that resolves
 * differently under test than in production is a package whose boundaries are
 * enforced against something other than what ships.
 *
 * Derived from the manifests rather than listed, so a new package needs no
 * edit here. The mapping mirrors each `exports` entry, `dist/x.js` → `src/x.ts`.
 */
function workspaceSourceAliases(): { find: RegExp; replacement: string }[] {
  const aliases: { find: RegExp; replacement: string }[] = [];
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(group)) {
      const dir = join(group, name);
      let manifest: {
        name?: string;
        exports?: Record<string, { default?: string }>;
      };
      try {
        manifest = JSON.parse(
          readFileSync(join(dir, "package.json"), "utf8"),
        ) as typeof manifest;
      } catch {
        continue;
      }
      if (manifest.name === undefined || manifest.exports === undefined) {
        continue;
      }
      for (const [subpath, target] of Object.entries(manifest.exports)) {
        const built = target.default;
        if (built === undefined) {
          continue;
        }
        const specifier =
          subpath === "."
            ? manifest.name
            : `${manifest.name}/${subpath.slice(2)}`;
        // Anchored, and the array form rather than an object: Vite matches
        // object keys as **prefixes**, so `@baas/persistence` swallowed
        // `@baas/persistence/testing` and resolved it to
        // `…/src/index.ts/testing`. An exact pattern has no ordering to get
        // wrong.
        aliases.push({
          find: new RegExp(`^${specifier.replace(/[/\\-]/g, "\\$&")}$`),
          replacement: join(
            import.meta.dirname,
            dir,
            built.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"),
          ),
        });
      }
    }
  }
  return aliases;
}

export default defineConfig({
  resolve: { alias: workspaceSourceAliases() },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
      /**
       * Workspace-level tests (New-13).
       *
       * The gates in `scripts/` belong to no package — a test for the boundary
       * gate has nothing to do with `contracts`, which is where an earlier
       * attempt put it and why it was removed. They are plain `.mjs`, like the
       * scripts they test, so the gates stay runnable by CI with no build step.
       */
      "scripts/**/*.test.mjs",
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
