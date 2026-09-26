// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Two tiers on purpose.
 *
 * Tier one is every package and app source file: fully type-checked linting,
 * because the rules that matter here (no `any`, no unnecessary condition, no
 * unsafe argument) need type information to mean anything.
 *
 * Tier two is the build's own files — config and scripts — which belong to no
 * TypeScript project and are linted syntactically. Putting them in a synthetic
 * tsconfig only to satisfy the parser buys nothing and hides a real project
 * boundary.
 */
/**
 * Two rules that must arrive with the seams they protect, not after.
 *
 * The incumbent service has 203 direct clock reads and 110 silent catch
 * blocks because both rules were written once the code already existed, at
 * which point the only way to land them is to disable them.
 */
const NO_SILENT_CATCH = {
  // `no-empty` ignores a block containing a comment, so `catch { /* ignore */ }`
  // passes it. Matching on an empty statement list catches both forms.
  selector: "CatchClause[body.body.length=0]",
  message:
    "Empty catch. Handle the error, or log it with describeError() and rethrow (RFC-BaaS §5.11, finding B5).",
};

const NO_DIRECT_CLOCK = [
  {
    selector: "NewExpression[callee.name='Date']",
    message:
      "Direct clock read. Inject the Clock port and use clock.now() (RFC-BaaS §5.9, finding B4).",
  },
  {
    selector:
      "CallExpression[callee.object.name='Date'][callee.property.name=/^(now|parse)$/]",
    message:
      "Direct clock read. Inject the Clock port, or use parseInstant() from @baas/platform (RFC-BaaS §5.9, finding B4).",
  },
];

/**
 * The clock boundary: the one implementation permitted to read the wall clock,
 * and its own test, which must compare against the real clock to prove the
 * implementation reads it. Nothing else in the workspace may appear here.
 */
const CLOCK_BOUNDARY_FILES = [
  "packages/platform/src/clock.ts",
  "packages/platform/src/clock.test.ts",
];

const TOOLING_FILES = [
  "*.mjs",
  "*.config.ts",
  "scripts/**/*.mjs",
  "scripts/**/*.js",
];

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    ignores: TOOLING_FILES,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // RFC-BaaS §5.1: `any` outside tests is zero, not twelve.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-syntax": ["error", NO_SILENT_CATCH, ...NO_DIRECT_CLOCK],
    },
  },
  {
    files: CLOCK_BOUNDARY_FILES,
    rules: {
      "no-restricted-syntax": ["error", NO_SILENT_CATCH],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: TOOLING_FILES,
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
);
