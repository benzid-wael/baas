#!/usr/bin/env node
/**
 * Gate: `.env.example` and the configuration schema agree (finding E4).
 *
 * The incumbent's `npm run check:config-parity` fails on `main` and is not
 * wired to CI, which is the worst of both: a check that exists, is believed,
 * and does not run.
 *
 * Every key the loader reads must appear in `.env.example` — commented out is
 * fine, that documents an optional setting — and every key in `.env.example`
 * must be one the loader reads, so a variable nobody consumes cannot linger
 * in a manifest looking meaningful.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOADER = `${ROOT}packages/platform/src/config/load.ts`;
const EXAMPLE = `${ROOT}.env.example`;

const loaderSource = readFileSync(LOADER, "utf8");
const read = new Set(
  [...loaderSource.matchAll(/env\[\s*"([A-Z0-9_]+)"\s*\]/g)].map((m) => m[1]),
);
// Provider credentials are read through a computed prefix, so they are
// declared rather than discovered.
for (const key of [
  "PROVIDER_KEEL_BASE_URL",
  "PROVIDER_KEEL_CLIENT_ID",
  "PROVIDER_KEEL_CLIENT_SECRET",
]) {
  read.add(key);
}

const exampleSource = readFileSync(EXAMPLE, "utf8");
const declared = new Set(
  [...exampleSource.matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]),
);

const missing = [...read].filter((key) => !declared.has(key)).sort();
const extra = [...declared].filter((key) => !read.has(key)).sort();

if (missing.length > 0 || extra.length > 0) {
  console.error("Config parity gate FAILED:\n");
  for (const key of missing) {
    console.error(
      `  - ${key} is read by the loader but absent from .env.example`,
    );
  }
  for (const key of extra) {
    console.error(`  - ${key} is in .env.example but read by nothing`);
  }
  process.exit(1);
}
console.log(`Config parity gate passed: ${read.size} keys agree.`);
