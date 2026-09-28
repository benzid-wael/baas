#!/usr/bin/env node
/**
 * Gate: every file a Dockerfile or compose file names actually exists.
 *
 * New-18 is the reason this exists. `docker-compose.yml` and the `Dockerfile`
 * both referenced `apps/api/dist/main.js` and `apps/worker/dist/main.js` for
 * several milestones, neither of which was ever built — so the `full` profile
 * failed immediately and nobody noticed, because nothing in CI looks at these
 * files. Every task passed its own tests.
 *
 * It checks the two things that broke, and nothing clever:
 *
 *   1. Every `COPY <source>` in a Dockerfile names a path that exists.
 *   2. Every `dockerfile:` a compose service names exists.
 *
 * Deliberately NOT a substitute for building the image. It catches the class
 * of mistake that shipped, not every mistake an image can contain.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

/** A COPY whose source is a build stage refers to no file on disk. */
const COPY = /^\s*COPY\s+(?<flags>(?:--\S+\s+)*)(?<paths>.+)$/gm;

for (const name of readdirSync(ROOT)) {
  if (!name.startsWith("Dockerfile")) {
    continue;
  }
  const source = readFileSync(join(ROOT, name), "utf8");
  for (const match of source.matchAll(COPY)) {
    const flags = match.groups?.flags ?? "";
    if (flags.includes("--from=")) {
      continue;
    }
    const parts = (match.groups?.paths ?? "").trim().split(/\s+/);
    // The last token is the destination inside the image.
    for (const path of parts.slice(0, -1)) {
      if (path.includes("*") || path.startsWith("$")) {
        continue;
      }
      if (!existsSync(join(ROOT, path))) {
        failures.push(`${name} copies "${path}", which does not exist.`);
      }
    }
  }
}

const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
for (const match of compose.matchAll(/^\s*dockerfile:\s*(\S+)\s*$/gm)) {
  const path = match[1];
  if (!existsSync(join(ROOT, path))) {
    failures.push(
      `docker-compose.yml builds with "${path}", which does not exist.`,
    );
  }
}

if (failures.length > 0) {
  console.error(`Docker reference gate FAILED (${failures.length}):\n`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error("");
  process.exit(1);
}
console.log("Docker reference gate passed: every referenced path exists.");
