#!/usr/bin/env node
/**
 * Domain purity gate — RFC-BaaS §3.2.
 *
 * `packages/domain` is the framework-free core. The rule that matters is that
 * it imports nothing. pnpm's isolated node_modules already makes a violation a
 * resolution error at build time; this gate states the rule explicitly so the
 * failure names the rule rather than a missing module, and so it also catches
 * Node built-ins, which resolve without being declared anywhere.
 *
 * Runtime dependencies: none, ever.
 * Dev dependencies: only the toolchain needed to compile and test the package.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOMAIN = join(ROOT, "packages", "domain");
const ALLOWED_DEV_DEPENDENCIES = new Set(["typescript", "vitest"]);
const ALLOWED_TEST_IMPORTS = new Set(["vitest"]);

const IMPORT_PATTERN =
  /(?:^|\s)(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

const failures = [];

function fail(message) {
  failures.push(message);
}

function walk(directory) {
  const entries = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      entries.push(...walk(path));
    } else if (name.endsWith(".ts")) {
      entries.push(path);
    }
  }
  return entries;
}

const manifest = JSON.parse(readFileSync(join(DOMAIN, "package.json"), "utf8"));

for (const field of [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
]) {
  const declared = Object.keys(manifest[field] ?? {});
  if (declared.length > 0) {
    fail(
      `packages/domain declares ${field}: ${declared.join(", ")}. ` +
        `The domain depends on nothing (RFC-BaaS §3.2).`,
    );
  }
}

for (const name of Object.keys(manifest.devDependencies ?? {})) {
  if (!ALLOWED_DEV_DEPENDENCIES.has(name)) {
    fail(
      `packages/domain declares devDependency "${name}", which is not in the ` +
        `toolchain allow-list (${[...ALLOWED_DEV_DEPENDENCIES].join(", ")}).`,
    );
  }
}

for (const file of walk(join(DOMAIN, "src"))) {
  const isTest = file.endsWith(".test.ts");
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier === undefined || specifier.startsWith(".")) {
      continue;
    }
    if (isTest && ALLOWED_TEST_IMPORTS.has(specifier)) {
      continue;
    }
    fail(
      `${relative(ROOT, file)} imports "${specifier}". ` +
        `The domain may only import relative paths` +
        `${isTest ? ` and ${[...ALLOWED_TEST_IMPORTS].join(", ")}` : ""}.`,
    );
  }
}

if (failures.length > 0) {
  console.error("Domain purity gate FAILED:\n");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error("");
  process.exit(1);
}

console.log("Domain purity gate passed: packages/domain depends on nothing.");
