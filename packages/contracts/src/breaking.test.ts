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
      { path: "schemas.Account.label", reason: "property became required" },
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
