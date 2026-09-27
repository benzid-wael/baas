import { describe, expect, it } from "vitest";
import { findBreakingChanges } from "./breaking.js";
import type { OpenApiDocument } from "./openapi.js";

function doc(
  schemas: Record<string, unknown>,
  paths: Record<string, unknown> = {},
  version = "0.1.0",
): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: { title: "baas", version },
    paths,
    components: { schemas },
  };
}

const ACCOUNT = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
  },
  required: ["id"],
};

describe("changes that break a client", () => {
  it("a removed schema", () => {
    expect(findBreakingChanges(doc({ Account: ACCOUNT }), doc({}))).toEqual([
      { path: "schemas.Account", reason: "schema removed" },
    ]);
  });

  it("a removed property", () => {
    const after = { ...ACCOUNT, properties: { id: { type: "string" } } };
    expect(
      findBreakingChanges(doc({ Account: ACCOUNT }), doc({ Account: after })),
    ).toEqual([{ path: "schemas.Account.label", reason: "property removed" }]);
  });

  it("a property that becomes required", () => {
    const after = { ...ACCOUNT, required: ["id", "label"] };
    expect(
      findBreakingChanges(doc({ Account: ACCOUNT }), doc({ Account: after })),
    ).toEqual([
      {
        path: "schemas.Account.label",
        reason: "property became required, which breaks a producer omitting it",
      },
    ]);
  });

  it("a property whose type changes", () => {
    const after = {
      ...ACCOUNT,
      properties: { id: { type: "string" }, label: { type: "number" } },
    };
    const changes = findBreakingChanges(
      doc({ Account: ACCOUNT }),
      doc({ Account: after }),
    );
    expect(changes[0]?.reason).toContain(
      'type changed from "string" to "number"',
    );
  });

  it("a removed path, operation and response", () => {
    const before = doc(
      {},
      {
        "/accounts": {
          get: { responses: { "200": {}, "404": {} } },
          post: { responses: { "201": {} } },
        },
        "/cards": { get: { responses: { "200": {} } } },
      },
    );
    const after = doc(
      {},
      { "/accounts": { get: { responses: { "200": {} } } } },
    );

    expect(findBreakingChanges(before, after)).toEqual([
      { path: "/accounts.get.responses.404", reason: "response removed" },
      { path: "/accounts.post", reason: "operation removed" },
      { path: "/cards", reason: "path removed" },
    ]);
  });

  it("finds a break inside array items", () => {
    // Without descending into `items`, a narrowed enum or a changed pattern
    // inside a list is invisible. This was a real gap: a capability report's
    // operations list changed its pattern and the detector reported the
    // document merely stale.
    const before = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
      },
    };
    const after = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string", enum: ["a"] } },
      },
    };
    const changes = findBreakingChanges(doc({ A: before }), doc({ A: after }));
    expect(changes[0]?.path).toBe("schemas.A.tags[]");
    expect(changes[0]?.reason).toContain('enum removed "b"');
  });

  it("finds a break nested inside a property", () => {
    const nested = {
      type: "object",
      properties: {
        holder: { type: "object", properties: { name: { type: "string" } } },
      },
    };
    const after = {
      type: "object",
      properties: { holder: { type: "object", properties: {} } },
    };
    expect(findBreakingChanges(doc({ A: nested }), doc({ A: after }))).toEqual([
      { path: "schemas.A.holder.name", reason: "property removed" },
    ]);
  });
});

describe("value-level changes (New-10)", () => {
  const status = {
    type: "object",
    properties: { state: { type: "string", enum: ["accepted", "settled"] } },
  };

  function withState(values: readonly string[]) {
    return {
      type: "object",
      properties: { state: { type: "string", enum: values } },
    };
  }

  it("reports an added enum member, which breaks an exhaustive switch", () => {
    // The direction that matters most here. A mobile client switching on
    // payment state falls through when the server invents a new one.
    const changes = findBreakingChanges(
      doc({ Status: status }),
      doc({ Status: withState(["accepted", "settled", "held"]) }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.reason).toContain('enum added "held"');
    expect(changes[0]?.reason).toContain("switching exhaustively");
  });

  it("reports a removed enum member, which breaks a producer", () => {
    const changes = findBreakingChanges(
      doc({ Status: status }),
      doc({ Status: withState(["settled"]) }),
    );
    expect(changes[0]?.reason).toContain('enum removed "accepted"');
    expect(changes[0]?.reason).toContain("still sending it");
  });

  it("reports both when an enum is replaced wholesale", () => {
    const changes = findBreakingChanges(
      doc({ Status: status }),
      doc({ Status: withState(["ok", "bad"]) }),
    );
    expect(changes).toHaveLength(2);
  });

  it("compares a bare enum schema, not only enums nested in properties", () => {
    const changes = findBreakingChanges(
      doc({ Currency: { type: "string", enum: ["AED", "USD"] } }),
      doc({ Currency: { type: "string", enum: ["AED"] } }),
    );
    expect(changes[0]?.path).toBe("schemas.Currency");
    expect(changes[0]?.reason).toContain("USD");
  });

  it.each([
    ["maxLength", 64, 32],
    ["maximum", 100, 50],
    ["maxItems", 10, 5],
  ])("reports a tightened %s", (key, was, now) => {
    const changes = findBreakingChanges(
      doc({ A: { type: "string", [key]: was } }),
      doc({ A: { type: "string", [key]: now } }),
    );
    expect(changes[0]?.reason).toBe(
      `${key} tightened from ${String(was)} to ${String(now)}`,
    );
  });

  it.each([
    ["minLength", 1, 4],
    ["minimum", 0, 1],
    ["minItems", 0, 1],
  ])("reports a raised %s", (key, was, now) => {
    const changes = findBreakingChanges(
      doc({ A: { type: "string", [key]: was } }),
      doc({ A: { type: "string", [key]: now } }),
    );
    expect(changes[0]?.reason).toContain("tightened");
  });

  it("does not report a loosened bound", () => {
    expect(
      findBreakingChanges(
        doc({ A: { type: "string", maxLength: 32 } }),
        doc({ A: { type: "string", maxLength: 64 } }),
      ),
    ).toEqual([]);
  });

  it("reports a changed or removed pattern and format", () => {
    expect(
      findBreakingChanges(
        doc({ A: { type: "string", pattern: "^a$" } }),
        doc({ A: { type: "string", pattern: "^ab$" } }),
      )[0]?.reason,
    ).toContain("pattern changed");

    expect(
      findBreakingChanges(
        doc({ A: { type: "string", format: "date-time" } }),
        doc({ A: { type: "string" } }),
      )[0]?.reason,
    ).toBe("format removed");
  });

  it("reports a property that stops being required", () => {
    const before = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    };
    const after = { type: "object", properties: { id: { type: "string" } } };
    expect(findBreakingChanges(doc({ A: before }), doc({ A: after }))).toEqual([
      {
        path: "schemas.A.id",
        reason:
          "property is no longer required, which breaks a consumer assuming it is present",
      },
    ]);
  });

  it("does not double-report a removed property as no-longer-required", () => {
    const before = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    };
    const after = { type: "object", properties: {} };
    const changes = findBreakingChanges(doc({ A: before }), doc({ A: after }));
    expect(changes).toEqual([
      { path: "schemas.A.id", reason: "property removed" },
    ]);
  });
});

describe("changes that do not break a client", () => {
  it("a new schema, path, response or optional property", () => {
    const before = doc(
      { Account: ACCOUNT },
      { "/a": { get: { responses: { "200": {} } } } },
    );
    const after = doc(
      {
        Account: {
          ...ACCOUNT,
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            nickname: { type: "string" },
          },
        },
        Card: { type: "object", properties: {} },
      },
      {
        "/a": { get: { responses: { "200": {}, "429": {} } } },
        "/b": { get: { responses: { "200": {} } } },
      },
    );
    expect(findBreakingChanges(before, after)).toEqual([]);
  });

  it("an unchanged document", () => {
    expect(
      findBreakingChanges(doc({ Account: ACCOUNT }), doc({ Account: ACCOUNT })),
    ).toEqual([]);
  });
});
