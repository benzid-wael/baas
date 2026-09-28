import { describe, expect, it } from "vitest";
import { evaluateWorkspace } from "./check-boundaries.mjs";

/**
 * Tests for the gate itself (New-13).
 *
 * Every structural rule in this codebase rests on one script. Its failure mode
 * is the dangerous kind: if it stops classifying a package — a manifest key
 * renamed, a path convention changed — it reports "all boundaries intact" and
 * the architecture quietly stops being enforced. That is worse than the gate
 * not existing, because it is believed.
 *
 * So each rule gets a fixture that **violates** it and one that does not.
 * Testing against the real workspace would prove nothing: every rule passes
 * there, which is exactly what a gate that classifies nothing also reports.
 */
function pkg(name, manifest = {}, files = []) {
  return {
    name,
    manifest: { name, baas: { layer: "application" }, ...manifest },
    files,
  };
}

const file = (path, source) => ({ path, source });
const importing = (specifier) =>
  file(
    "src/index.ts",
    `import { x } from "${specifier}";\nexport const y = x;`,
  );

describe("rule 1 — every package declares its layer", () => {
  it("reports a package with no layer", () => {
    const failures = evaluateWorkspace([
      {
        name: "packages/mystery",
        manifest: { name: "@baas/mystery" },
        files: [],
      },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/declares no "baas.layer"/);
  });

  it("reports a layer nobody has heard of, and lists the real ones", () => {
    const failures = evaluateWorkspace([
      pkg("packages/x", { baas: { layer: "middleware" } }),
    ]);
    expect(failures[0]).toMatch(/unknown layer "middleware"/);
    expect(failures[0]).toMatch(/domain/);
  });

  it("says nothing about a package that declares one", () => {
    expect(evaluateWorkspace([pkg("packages/x")])).toEqual([]);
  });
});

describe("rule 2 — dependencies point inward", () => {
  const target = pkg("packages/app", {
    name: "@baas/app",
    baas: { layer: "app" },
  });

  it("reports an import of an equal layer", () => {
    // The case rank equality is for: contracts and platform must not import
    // each other, which is what keeps a generated client free of
    // infrastructure.
    const failures = evaluateWorkspace([
      pkg(
        "packages/contracts",
        {
          name: "@baas/contracts",
          baas: { layer: "contracts" },
          dependencies: { "@baas/platform": "workspace:*" },
        },
        [importing("@baas/platform")],
      ),
      pkg("packages/platform", {
        name: "@baas/platform",
        baas: { layer: "platform" },
      }),
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/point inward/);
  });

  it("reports an import of a higher layer", () => {
    const failures = evaluateWorkspace([
      pkg(
        "packages/domainish",
        {
          name: "@baas/domainish",
          baas: { layer: "persistence" },
          dependencies: { "@baas/app": "workspace:*" },
        },
        [importing("@baas/app")],
      ),
      target,
    ]);
    expect(failures[0]).toMatch(/layer "app".*from layer "persistence"/s);
  });

  it("permits an import of a strictly lower layer", () => {
    expect(
      evaluateWorkspace([
        pkg(
          "packages/application",
          {
            name: "@baas/application",
            baas: { layer: "application" },
            dependencies: { "@baas/domain": "workspace:*" },
          },
          [importing("@baas/domain")],
        ),
        pkg("packages/domain", {
          name: "@baas/domain",
          baas: { layer: "domain" },
        }),
      ]),
    ).toEqual([]);
  });
});

describe("rule 3 — every bare import is declared", () => {
  it("reports an undeclared runtime import", () => {
    // Correction C3: pnpm isolates transitive dependencies, but Node
    // resolution walks up the tree, so anything at the workspace root is
    // importable everywhere. This rule is the only thing that catches it.
    const failures = evaluateWorkspace([
      pkg("packages/x", {}, [importing("zod")]),
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/does not declare in dependencies/);
  });

  it("refuses a devDependency in runtime source, and says why", () => {
    const failures = evaluateWorkspace([
      pkg("packages/x", { devDependencies: { zod: "^4" } }, [importing("zod")]),
    ]);
    expect(failures[0]).toMatch(/A devDependency is not available at runtime/);
  });

  it("permits a devDependency in a test", () => {
    expect(
      evaluateWorkspace([
        pkg("packages/x", { devDependencies: { vitest: "^2" } }, [
          file(
            "src/a.test.ts",
            `import { it } from "vitest";\nit("x", () => {});`,
          ),
        ]),
      ]),
    ).toEqual([]);
  });

  it("permits a devDependency in a declared tool file", () => {
    expect(
      evaluateWorkspace([
        pkg(
          "packages/x",
          {
            devDependencies: { vite: "^6" },
            baas: { layer: "application", toolFiles: ["src/build.ts"] },
          },
          [importing("vite")].map((f) => ({ ...f, path: "src/build.ts" })),
        ),
      ]),
    ).toEqual([]);
  });

  it("permits a peer dependency", () => {
    expect(
      evaluateWorkspace([
        pkg("packages/x", { peerDependencies: { zod: "^4" } }, [
          importing("zod"),
        ]),
      ]),
    ).toEqual([]);
  });
});

describe("rule 4a — the domain depends on nothing", () => {
  it("reports any runtime dependency", () => {
    const failures = evaluateWorkspace([
      pkg("packages/domain", {
        baas: { layer: "domain" },
        dependencies: { zod: "^4" },
      }),
    ]);
    expect(failures[0]).toMatch(/The domain depends on nothing/);
  });

  it("reports a devDependency outside the toolchain allow-list", () => {
    const failures = evaluateWorkspace([
      pkg("packages/domain", {
        baas: { layer: "domain" },
        devDependencies: { lodash: "^4" },
      }),
    ]);
    expect(failures[0]).toMatch(/outside the toolchain allow-list/);
  });

  it("permits the toolchain itself", () => {
    expect(
      evaluateWorkspace([
        pkg("packages/domain", {
          baas: { layer: "domain" },
          devDependencies: { typescript: "^5", vitest: "^2" },
        }),
      ]),
    ).toEqual([]);
  });
});

describe("rule 4b — only a Node package touches a Node built-in", () => {
  for (const specifier of ["node:fs", "crypto", "fs"]) {
    it(`reports "${specifier}" in a neutral package`, () => {
      const failures = evaluateWorkspace([
        pkg(
          "packages/x",
          { baas: { layer: "domain", environment: "neutral" } },
          [importing(specifier)],
        ),
      ]);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(/must run anywhere|declares environment/);
    });
  }

  it("reports it in a browser package too", () => {
    const failures = evaluateWorkspace([
      pkg("apps/portal", { baas: { layer: "app", environment: "browser" } }, [
        importing("node:crypto"),
      ]),
    ]);
    expect(failures[0]).toMatch(/environment "browser"/);
  });

  it("permits it in a node package, which is the default", () => {
    expect(
      evaluateWorkspace([pkg("packages/x", {}, [importing("node:fs")])]),
    ).toEqual([]);
  });

  it("permits it in a declared tool file of a neutral package", () => {
    expect(
      evaluateWorkspace([
        pkg(
          "packages/contracts",
          {
            baas: {
              layer: "contracts",
              environment: "neutral",
              toolFiles: ["src/cli.ts"],
            },
          },
          [{ ...importing("node:fs"), path: "src/cli.ts" }],
        ),
      ]),
    ).toEqual([]);
  });
});

describe("rule 5 — the target must run where the importer runs", () => {
  const platform = pkg("packages/platform", {
    name: "@baas/platform",
    baas: { layer: "platform", environment: "node" },
  });
  const contracts = pkg("packages/contracts", {
    name: "@baas/contracts",
    baas: { layer: "contracts", environment: "neutral" },
  });

  const portal = (files) =>
    pkg(
      "apps/portal",
      {
        name: "@baas/portal",
        baas: { layer: "app", environment: "browser" },
        dependencies: {
          "@baas/platform": "workspace:*",
          "@baas/contracts": "workspace:*",
        },
      },
      files,
    );

  it("reports a browser package importing a node one", () => {
    // Rank alone cannot express this: the portal sits above platform, so the
    // inward rule is perfectly happy.
    const failures = evaluateWorkspace([
      portal([importing("@baas/platform")]),
      platform,
      contracts,
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/runs in "node".*runs in "browser"/s);
  });

  it("permits a browser package importing a neutral one", () => {
    expect(
      evaluateWorkspace([
        portal([importing("@baas/contracts")]),
        platform,
        contracts,
      ]),
    ).toEqual([]);
  });

  it("does not exempt a test file", () => {
    // A browser package's tests run in a browser-like environment too, and a
    // test that reaches for `pg` proves nothing about the code that ships.
    const failures = evaluateWorkspace([
      portal([{ ...importing("@baas/platform"), path: "src/a.test.ts" }]),
      platform,
      contracts,
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/runs in "node"/);
  });

  it("reports an unknown environment rather than assuming one", () => {
    const failures = evaluateWorkspace([
      pkg("packages/x", { baas: { layer: "app", environment: "deno" } }),
    ]);
    expect(failures[0]).toMatch(/unknown environment "deno"/);
  });
});

describe("what the import matcher sees", () => {
  const seen = (source) =>
    evaluateWorkspace([pkg("packages/x", {}, [file("src/index.ts", source)])]);

  it("catches a plain import", () => {
    expect(seen(`import x from "zod";`)).toHaveLength(1);
  });

  it("catches a type-only import", () => {
    // A type import resolves at build time and still ties two packages
    // together; excluding it would let the graph drift invisibly.
    expect(seen(`import type { X } from "zod";`)).toHaveLength(1);
  });

  it("catches a re-export", () => {
    expect(seen(`export * from "zod";`)).toHaveLength(1);
  });

  it("catches a dynamic import and a require", () => {
    expect(seen(`const x = await import("zod");`)).toHaveLength(1);
    expect(seen(`const x = require("zod");`)).toHaveLength(1);
  });

  it("ignores a relative import", () => {
    expect(seen(`import x from "./sibling.js";`)).toEqual([]);
  });

  it("reads a scoped package name as two segments", () => {
    const failures = seen(`import x from "@scope/name/deep/path.js";`);
    expect(failures[0]).toMatch(/"@scope\/name"/);
  });

  it("reads an unscoped subpath as one segment", () => {
    const failures = seen(`import x from "zod/v4";`);
    expect(failures[0]).toMatch(/"zod"/);
  });
});

describe("every rule reports, rather than stopping at the first", () => {
  it("collects violations across packages", () => {
    // A gate that stops at the first failure turns a broken workspace into a
    // sequence of runs, each revealing one more rule — the same defect the
    // configuration loader was written to avoid.
    const failures = evaluateWorkspace([
      { name: "packages/a", manifest: { name: "a" }, files: [] },
      pkg("packages/b", {}, [importing("zod")]),
      pkg("packages/c", {
        baas: { layer: "domain" },
        dependencies: { x: "1" },
      }),
    ]);
    expect(failures).toHaveLength(3);
  });
});

describe("prose is not an import", () => {
  const seen = (source) =>
    evaluateWorkspace([pkg("packages/x", {}, [file("src/index.ts", source)])]);

  it("ignores the word `from` inside a string literal", () => {
    // A real false failure. `codegen.ts` emits TypeScript as strings, and one
    // of its lines ended "...come from" — the matcher then treated everything
    // up to the next quote as a package name and refused the build. The gap
    // between `import` and `from` may not contain a quote.
    expect(
      seen(
        `export const lines = [\n  "// comments come from",\n  "// the migrations",\n];`,
      ),
    ).toEqual([]);
  });

  it("still catches a multi-line import", () => {
    // The tightening must not cost this: real imports span lines constantly
    // and never contain a quote before `from`.
    expect(seen(`import {\n  a,\n  b,\n} from "zod";`)).toHaveLength(1);
  });

  it("does not run one statement into the next", () => {
    const failures = seen(`import a from "alpha"; import b from "beta";`);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/"alpha"/);
    expect(failures[1]).toMatch(/"beta"/);
  });
});
