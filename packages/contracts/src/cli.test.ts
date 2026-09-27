import { describe, expect, it } from "vitest";
import { checkDocument, currentDocument } from "./cli.js";
import { serializeDocument } from "./openapi.js";
import type { OpenApiDocument } from "./openapi.js";

describe("checkDocument", () => {
  const generated = currentDocument();

  it("passes when the committed document matches", () => {
    const result = checkDocument(serializeDocument(generated), generated);
    expect(result.code).toBe(0);
  });

  it("fails when the committed document is missing", () => {
    const result = checkDocument(undefined, generated);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("missing");
  });

  it("fails as merely stale for an additive change", () => {
    const previous: OpenApiDocument = {
      ...generated,
      components: { schemas: {} },
    };
    const result = checkDocument(serializeDocument(previous), generated);
    expect(result.code).toBe(1);
    const output = result.lines.join("\n");
    expect(output).toContain("stale");
    expect(output).not.toContain("breaking change");
  });

  it("refuses a breaking change that leaves the version alone", () => {
    const previous: OpenApiDocument = {
      ...generated,
      components: {
        schemas: {
          ...generated.components.schemas,
          Removed: { type: "object", properties: {} },
        },
      },
    };
    const result = checkDocument(serializeDocument(previous), generated);
    const output = result.lines.join("\n");
    expect(result.code).toBe(1);
    expect(output).toContain("1 breaking change");
    expect(output).toContain("schemas.Removed: schema removed");
    expect(output).toContain("requires an explicit bump");
  });

  it("accepts a breaking change once the version is bumped deliberately", () => {
    const previous: OpenApiDocument = {
      ...generated,
      info: { ...generated.info, version: "0.0.9" },
      components: {
        schemas: {
          ...generated.components.schemas,
          Removed: { type: "object", properties: {} },
        },
      },
    };
    const output = checkDocument(
      serializeDocument(previous),
      generated,
    ).lines.join("\n");
    expect(output).toContain("so the break is deliberate");
    expect(output).not.toContain("requires an explicit bump");
  });
});

describe("the published registry", () => {
  it("is deterministic, so a CI diff means what it says", () => {
    expect(serializeDocument(currentDocument())).toBe(
      serializeDocument(currentDocument()),
    );
  });

  it("publishes only paths that have a controller behind them", () => {
    // Paths arrive with the milestone that mounts them. A documented endpoint
    // with no route is worse than an undocumented one, because a client will
    // be written against it — which is why New-12 compares the two.
    expect(Object.keys(currentDocument().paths).sort()).toEqual([
      "/mobile/accounts",
      "/mobile/accounts/{accountReference}",
      "/mobile/accounts/{accountReference}/transactions",
      "/platform/accounts/{accountReference}/transactions",
      "/platform/customers",
      "/platform/customers/{customerId}/accounts",
    ]);
  });
});
