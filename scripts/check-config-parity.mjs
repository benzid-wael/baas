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
/**
 * Provider settings are read through a computed prefix, so they are checked
 * differently from the rest.
 *
 * The loader reads every suffix for every declared provider — it is generic on
 * purpose, so that adding a provider is a manifest change. Demanding the full
 * cross-product in `.env.example` would therefore demand `PROVIDER_KEEL_ENTITY`,
 * which is meaningless: `entity` is a BaNCS setting. So the rule is weaker and
 * truer: **every suffix the loader reads must be documented against at least
 * one provider, and every provider key in the example must use a suffix the
 * loader reads.**
 *
 * The suffixes come from the loader itself, so a new setting cannot be added
 * there and forgotten here.
 */
const providerSuffixes = new Set(
  [...loaderSource.matchAll(/env\[`\$\{prefix\}_([A-Z0-9_]+)`\]/g)].map(
    (m) => m[1],
  ),
);
if (providerSuffixes.size === 0) {
  console.error(
    "Config parity gate FAILED: no PROVIDER_<NAME>_* reads found in the loader.",
  );
  console.error(
    "The pattern this gate matches has changed. Fix the gate, do not delete it.",
  );
  process.exit(1);
}

const exampleSource = readFileSync(EXAMPLE, "utf8");
const declared = new Set(
  [...exampleSource.matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]),
);

const providerKeys = [...declared].filter((key) => key.startsWith("PROVIDER_"));
// `PROVIDER_CREDENTIAL_ENCRYPTION_KEY` is a global secret, not a provider
// setting, and is checked by the generic rule below.
const providerSettingKeys = providerKeys.filter(
  (key) => !read.has(key) && key !== "PROVIDERS",
);

const documentedSuffixes = new Set();
const unknownSuffix = [];
for (const key of providerSettingKeys) {
  const suffix = [...providerSuffixes].find((candidate) =>
    key.endsWith(`_${candidate}`),
  );
  if (suffix === undefined) {
    unknownSuffix.push(key);
  } else {
    documentedSuffixes.add(suffix);
  }
}
const undocumentedSuffixes = [...providerSuffixes]
  .filter((suffix) => !documentedSuffixes.has(suffix))
  .sort();

// Provider keys are accounted for above; exclude them from the generic rule.
for (const key of providerSettingKeys) {
  declared.delete(key);
}

const missing = [...read].filter((key) => !declared.has(key)).sort();
const extra = [...declared].filter((key) => !read.has(key)).sort();

if (
  missing.length > 0 ||
  extra.length > 0 ||
  unknownSuffix.length > 0 ||
  undocumentedSuffixes.length > 0
) {
  console.error("Config parity gate FAILED:\n");
  for (const key of missing) {
    console.error(
      `  - ${key} is read by the loader but absent from .env.example`,
    );
  }
  for (const key of extra) {
    console.error(`  - ${key} is in .env.example but read by nothing`);
  }
  for (const key of unknownSuffix) {
    console.error(
      `  - ${key} is in .env.example but is not a provider setting the loader reads`,
    );
  }
  for (const suffix of undocumentedSuffixes) {
    console.error(
      `  - the loader reads PROVIDER_<NAME>_${suffix} and no provider documents it in .env.example`,
    );
  }
  process.exit(1);
}
console.log(
  `Config parity gate passed: ${read.size} keys and ${providerSuffixes.size} provider settings agree.`,
);
