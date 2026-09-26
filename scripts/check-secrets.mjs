#!/usr/bin/env node
/**
 * Gate: no credential is committed.
 *
 * Deliberately narrow. A scanner that reports every high-entropy string is a
 * scanner people learn to ignore, and an ignored gate is worse than none. It
 * looks for the shapes that are unambiguous: a private key block, an assigned
 * secret that is neither a placeholder nor an obvious example, and a
 * provider-style token prefix.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);
/** Files that legitimately contain key material for tests. */
const ALLOWED = new Set([
  "packages/platform/src/config/fixtures.ts",
  ".env.example",
]);

/**
 * Unambiguous credential shapes. Banned everywhere, tests included: a real
 * private key or a live provider token in a test file is still a leaked
 * credential, and "it was only a fixture" is what the postmortem says.
 */
const ALWAYS = [
  [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, "a private key block"],
  [/\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}/, "a provider secret key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key id"],
  [/\bghp_[A-Za-z0-9]{30,}\b/, "a GitHub token"],
];

/**
 * A generic assignment. Applied to non-test source only: a test that needs a
 * secret-shaped constant is the normal case, and flagging every one of them
 * teaches people to ignore the gate. The cost is stated rather than hidden —
 * this gate does not read test fixtures for generic assignments.
 */
const SOURCE_ONLY = [
  [
    /(password|secret|token|api[_-]?key)\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    "an assigned credential",
  ],
];
const PLACEHOLDER =
  /changeme|placeholder|example|insecure|notarealhash|xxxx|test|fake|dummy|\$2b\$/i;

const findings = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|mjs|js|json|ya?ml|sql|env|example)$/.test(path))
      out.push(path);
  }
  return out;
}

for (const file of walk(ROOT)) {
  const shown = relative(ROOT, file);
  if (ALLOWED.has(shown)) continue;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (PLACEHOLDER.test(line)) return;
      const patterns = shown.endsWith(".test.ts")
        ? ALWAYS
        : [...ALWAYS, ...SOURCE_ONLY];
      for (const [pattern, what] of patterns) {
        if (pattern.test(line)) {
          findings.push(`${shown}:${index + 1}  looks like ${what}`);
          return;
        }
      }
    });
}

if (findings.length > 0) {
  console.error(`Secret gate FAILED (${findings.length}):\n`);
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}
console.log("Secret gate passed: no committed credentials.");
