#!/usr/bin/env node
/**
 * Boundary gate — RFC-BaaS §3.2, generalising the T1 domain-purity check.
 *
 * Five rules, each answering something the incumbent could not enforce:
 *
 *   1. Every package declares its layer, in its own package.json.
 *   2. A package may import another only in the inward direction.
 *   3. Every bare import is declared by the importing package.
 *   4. The domain imports nothing, and a package that is not Node-only
 *      imports no Node built-in.
 *   5. A package may import another only if the target runs where it runs.
 *
 * Rule 3 is the one resolution cannot provide. Correction C3: pnpm isolates
 * transitive dependencies, but Node resolution walks up the directory tree, so
 * anything installed at the workspace root is importable from every package.
 * The root holds only the toolchain today; this rule is what keeps a runtime
 * library added there from silently becoming importable from the domain.
 *
 * The layer lives in each package's own manifest rather than in a table here,
 * so adding a package means declaring what it is — not editing the gate.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Inward ranks. A package may import a strictly lower rank, never an equal or
 * higher one — so `contracts` and `platform` cannot import each other, which
 * is what keeps the generated client free of infrastructure.
 *
 * A layer is added here when the first package of that layer arrives, and not
 * before: speculating about a rank for a package nobody has written is how a
 * boundary ends up shaped around an imagined design.
 */
const LAYER_RANK = {
  domain: 0,
  contracts: 1,
  platform: 1,
  persistence: 2,
  // Adapters sit beside persistence, not above it, so an adapter cannot import
  // a repository. An adapter that needs a database row is not an adapter.
  provider: 2,
  application: 3,
  // Composition: the layer that is allowed to know concrete providers by name.
  // It exists so that `apps/api` and `apps/worker` do not each build the same
  // adapters from the same configuration, which is how two copies of a wiring
  // rule drift apart.
  composition: 4,
  app: 9,
  // System tests wire several apps together, which is the one legitimate
  // reason to import across the top layer. Nothing production may sit here.
  e2e: 10,
};

/**
 * Where a package's code has to be able to run (MP-6).
 *
 * Rank alone cannot express this. `apps/portal` sits at layer `app`, above
 * `platform` — so rule 2 is perfectly happy for it to import `pino`, `pg` and
 * a Node built-in, none of which exist in a browser. The failure would be a
 * build error at best and a 400KB polyfill of `node:crypto` at worst, and
 * neither is what the boundary is for.
 *
 * So environment is a **second, independent axis**:
 *
 *   neutral  runs anywhere. Importable by everything.
 *   node     needs a Node runtime. Importable only by `node`.
 *   browser  needs a DOM. Importable only by `browser`.
 *
 * Declared per package as `baas.environment`. The default is `node`, because
 * that is what everything written before this rule was, and a default that
 * silently widens what a package may import is the wrong default.
 */
const ENVIRONMENTS = new Set(["neutral", "node", "browser"]);
const DEFAULT_ENVIRONMENT = "node";

/** Which environments a package of a given environment may import from. */
const MAY_IMPORT = {
  neutral: new Set(["neutral"]),
  node: new Set(["neutral", "node"]),
  browser: new Set(["neutral", "browser"]),
};

/** The domain declares no runtime dependencies at all. */
const DOMAIN_DEV_ALLOW_LIST = new Set(["typescript", "vitest"]);

const IMPORT_PATTERN =
  /(?:^|\s)(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

const failures = [];
const fail = (message) => failures.push(message);

function walk(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      found.push(...walk(path));
    } else if (path.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

function discoverPackages() {
  const packages = [];
  for (const group of ["packages", "apps"]) {
    const base = join(ROOT, group);
    let entries;
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of entries) {
      const manifestPath = join(base, name, "package.json");
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        packages.push({ dir: join(base, name), manifest });
      } catch {
        // A directory without a manifest is not a package.
      }
    }
  }
  return packages;
}

const packages = discoverPackages();
const byName = new Map(packages.map((p) => [p.manifest.name, p]));

for (const { dir, manifest } of packages) {
  const where = relative(ROOT, dir);
  const layer = manifest.baas?.layer;

  // Rule 1 — declared layer.
  if (layer === undefined) {
    fail(
      `${where}/package.json declares no "baas.layer". Add one of: ${Object.keys(LAYER_RANK).join(", ")}.`,
    );
    continue;
  }
  if (!(layer in LAYER_RANK)) {
    fail(
      `${where}/package.json declares unknown layer "${layer}". Known layers: ${Object.keys(LAYER_RANK).join(", ")}.`,
    );
    continue;
  }

  const environment = manifest.baas?.environment ?? DEFAULT_ENVIRONMENT;
  if (!ENVIRONMENTS.has(environment)) {
    fail(
      `${where}/package.json declares unknown environment "${environment}". Known environments: ${[...ENVIRONMENTS].join(", ")}.`,
    );
    continue;
  }

  const runtime = new Set(Object.keys(manifest.dependencies ?? {}));
  const dev = new Set(Object.keys(manifest.devDependencies ?? {}));
  const peer = new Set(Object.keys(manifest.peerDependencies ?? {}));
  const toolFiles = new Set(
    (manifest.baas?.toolFiles ?? []).map((file) => join(dir, file)),
  );

  // Rule 4a — the domain declares nothing.
  if (layer === "domain") {
    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const declared = Object.keys(manifest[field] ?? {});
      if (declared.length > 0) {
        fail(
          `${where} declares ${field}: ${declared.join(", ")}. The domain depends on nothing.`,
        );
      }
    }
    for (const name of dev) {
      if (!DOMAIN_DEV_ALLOW_LIST.has(name)) {
        fail(
          `${where} declares devDependency "${name}", outside the toolchain allow-list (${[...DOMAIN_DEV_ALLOW_LIST].join(", ")}).`,
        );
      }
    }
  }

  let sources;
  try {
    sources = walk(join(dir, "src"));
  } catch {
    continue;
  }

  for (const file of sources) {
    const isTest = file.endsWith(".test.ts");
    const isTool = toolFiles.has(file);
    const shown = relative(ROOT, file);
    const source = readFileSync(file, "utf8");

    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier === undefined || specifier.startsWith(".")) {
        continue;
      }

      // Rule 4b — only a Node package may touch a Node built-in.
      if (
        specifier.startsWith("node:") ||
        specifier === "crypto" ||
        specifier === "fs"
      ) {
        if (environment !== "node" && !isTool && !isTest) {
          fail(
            `${shown} imports "${specifier}", but ${where} declares environment "${environment}". Declare the file in "baas.toolFiles" if it is a build tool rather than part of the published surface.`,
          );
        }
        continue;
      }

      const packageName = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];

      // Rule 3 — declared by the importer. A tool file is build- or test-time
      // only and not part of the published runtime surface, so it may use
      // devDependencies — the same exemption that lets it touch Node built-ins.
      const mayUseDev = isTest || isTool;
      const declared =
        runtime.has(packageName) ||
        peer.has(packageName) ||
        (mayUseDev && dev.has(packageName));
      if (!declared) {
        fail(
          mayUseDev
            ? `${shown} imports "${packageName}", which ${where} does not declare in dependencies or devDependencies.`
            : `${shown} imports "${packageName}", which ${where} does not declare in dependencies. A devDependency is not available at runtime.`,
        );
        continue;
      }

      // Rule 2 — inward only.
      const target = byName.get(packageName);
      if (target === undefined) {
        continue;
      }
      const targetLayer = target.manifest.baas?.layer;
      if (targetLayer === undefined || !(targetLayer in LAYER_RANK)) {
        continue;
      }
      if (LAYER_RANK[targetLayer] >= LAYER_RANK[layer]) {
        fail(
          `${shown} imports "${packageName}" (layer "${targetLayer}") from layer "${layer}". Dependencies point inward: a package may only import a strictly lower layer.`,
        );
      }

      // Rule 5 — the target must run where the importer runs. A test file is
      // NOT exempt: a browser package's tests run in a browser-like
      // environment too, and a test that reaches for `pg` proves nothing about
      // the code that ships.
      const targetEnvironment =
        target.manifest.baas?.environment ?? DEFAULT_ENVIRONMENT;
      if (!MAY_IMPORT[environment].has(targetEnvironment)) {
        fail(
          `${shown} imports "${packageName}", which runs in "${targetEnvironment}", from ${where}, which runs in "${environment}". A package may only import one that runs where it runs.`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error(
    `Boundary gate FAILED (${failures.length} problem${failures.length === 1 ? "" : "s"}):\n`,
  );
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error("");
  process.exit(1);
}

console.log(
  `Boundary gate passed: ${packages.length} packages, all boundaries intact.`,
);
