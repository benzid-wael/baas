#!/usr/bin/env node
/**
 * Gate: the tenant context is never set session-wide (New-14, M1-1).
 *
 * `set_config(name, value, false)` is session-scoped. `pg` pools connections,
 * so the setting outlives the request that set it and the next request on that
 * connection inherits the previous tenant's context. Under row-level security
 * that is a cross-tenant read, and it is invisible in a single-tenant
 * deployment — which is every deployment today.
 *
 * Also bans `SET ROLE` without `LOCAL`, for the same reason: a role change
 * that outlives its transaction is a privilege change nobody asked for.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const findings = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|sql)$/.test(path)) out.push(path);
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
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        // Skip comments. Both of these rules are worth explaining in prose
        // next to the code that obeys them, and a gate that flags its own
        // documentation is a gate people delete.
        const trimmed = line.trim();
        if (
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*") ||
          trimmed.startsWith("--")
        ) {
          return;
        }
        if (/set_config\s*\([^)]*,\s*false\s*\)/.test(line)) {
          findings.push(
            `${shown}:${index + 1}  set_config(..., false) is session-scoped and survives into the next request on a pooled connection. Use true, inside a transaction.`,
          );
        }
        if (
          /\bSET\s+ROLE\b/i.test(line) &&
          !/\bSET\s+LOCAL\s+ROLE\b/i.test(line)
        ) {
          findings.push(
            `${shown}:${index + 1}  SET ROLE without LOCAL outlives its transaction. Use SET LOCAL ROLE.`,
          );
        }
      });
  }
}

if (findings.length > 0) {
  console.error(`Tenant-scope gate FAILED (${findings.length}):\n`);
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}
console.log("Tenant-scope gate passed: no session-scoped tenant context.");
