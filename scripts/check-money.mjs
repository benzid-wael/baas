#!/usr/bin/env node
/**
 * Gate: floats never touch money (RFC-BaaS §5.8, finding A5).
 *
 * The incumbent converts to `Number` at `ruya-bank-payout.service.ts:571` and
 * declares `@IsNumber() amount!: number` on payment DTOs. Floating point in a
 * money path is a correctness risk regardless of current amounts, so the
 * grep is a gate rather than a guideline.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MONEY = /amount|balance|price|fee|minorUnits|currency/i;
const FLOAT = /parseFloat\s*\(|Number\s*\(|\btoFixed\s*\(|:\s*number\b/;
/** The one place permitted to reason about a scale as a number. */
const ALLOWED = new Set([
  "packages/domain/src/currency.ts",
  "packages/domain/src/money.ts",
  "packages/contracts/src/primitives.ts",
]);

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

for (const group of ["packages", "apps"]) {
  let files;
  try {
    files = walk(join(ROOT, group));
  } catch {
    continue;
  }
  for (const file of files) {
    const shown = relative(ROOT, file);
    if (ALLOWED.has(shown)) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (MONEY.test(line) && FLOAT.test(line)) {
          findings.push(`${shown}:${index + 1}  ${line.trim().slice(0, 100)}`);
        }
      });
  }
}

if (findings.length > 0) {
  console.error(`Money gate FAILED (${findings.length}):\n`);
  for (const finding of findings) console.error(`  - ${finding}`);
  console.error(
    "\nMoney is bigint minor units plus a currency. See RFC-BaaS §5.8.",
  );
  process.exit(1);
}
console.log("Money gate passed: no float on a money path.");
