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
 * A log message is free text, and no field allow-list can govern it (New-8).
 * `logger.info({ ... }, `sending OTP to ${mobile}`)` defeats the control
 * entirely, because the value is inside a string before pino sees it.
 *
 * So the message must be a literal, and every variable goes through a named
 * field — where the allow-list already applies and an unlisted name is dropped
 * and reported. This is the primary control; `scrubText` is the second line,
 * for words a provider put there.
 */
const NO_INTERPOLATED_LOG_MESSAGE = [
  {
    selector:
      "CallExpression[callee.property.name=/^(fatal|error|warn|info|debug|trace)$/] > TemplateLiteral[expressions.length>0]",
    message:
      "A log message must be a literal. Put the value in a named field instead, where the allow-list applies (RFC-BaaS 5.11, New-8).",
  },
  {
    selector:
      "CallExpression[callee.property.name=/^(fatal|error|warn|info|debug|trace)$/] > BinaryExpression[operator='+']",
    message:
      "A log message must be a literal. Concatenation hides the value from the field allow-list (RFC-BaaS 5.11, New-8).",
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
  // The browser's own boundary. `@baas/platform` runs on Node, so the portal
  // cannot import the port above and needs one permitted file of its own.
  "apps/portal/src/clock.ts",
];

const TOOLING_FILES = [
  "*.mjs",
  "*.config.ts",
  // The portal's build config belongs to no TypeScript project, like every
  // other `*.config.ts` in the workspace.
  "apps/*/*.config.ts",
  "scripts/**/*.mjs",
  "scripts/**/*.js",
];

export default tseslint.config(
  {
    // `dist-types` is the portal's declaration output: `vite build` owns
    // `dist`, so `tsc --build` cannot also write there.
    ignores: [
      "**/dist/**",
      "**/dist-types/**",
      "**/coverage/**",
      "**/node_modules/**",
    ],
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
      "no-restricted-syntax": [
        "error",
        NO_SILENT_CATCH,
        ...NO_DIRECT_CLOCK,
        ...NO_INTERPOLATED_LOG_MESSAGE,
      ],
    },
  },
  {
    files: CLOCK_BOUNDARY_FILES,
    rules: {
      "no-restricted-syntax": [
        "error",
        NO_SILENT_CATCH,
        ...NO_INTERPOLATED_LOG_MESSAGE,
      ],
    },
  },
  {
    // Nest modules are classes by contract, and a test double for a Nest
    // ExecutionContext is legitimately an empty class.
    files: ["apps/api/**/*.ts", "apps/e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
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
