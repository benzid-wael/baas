#!/usr/bin/env node
/**
 * Gate: `any` outside tests is zero, not twelve (RFC-BaaS §5.1).
 *
 * The lint rule bans the `any` keyword, but a file can still reintroduce it
 * through `eslint-disable`. This counts both, so silencing the rule is as
 * visible as using it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ROOTS = ["packages", "apps"];
const findings = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

for (const group of ROOTS) {
  let files;
  try {
    files = walk(join(ROOT, group));
  } catch {
    continue;
  }
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/\bas\s+any\b|:\s*any\b|<any>/.test(line)) {
        findings.push(`${relative(ROOT, file)}:${index + 1}  uses \`any\``);
      }
      if (/eslint-disable.*no-explicit-any/.test(line)) {
        findings.push(
          `${relative(ROOT, file)}:${index + 1}  disables the no-explicit-any rule`,
        );
      }
    });
  }
}

if (findings.length > 0) {
  console.error(`\`any\` gate FAILED (${findings.length}):\n`);
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}
console.log("`any` gate passed: no `any` in non-test source.");
