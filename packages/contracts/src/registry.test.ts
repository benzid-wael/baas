import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DuplicateContractError,
  RegistryBuilder,
  UnregisteredSchemaError,
} from "./registry.js";

describe("RegistryBuilder", () => {
  it("refuses a duplicate schema name", () => {
    const builder = new RegistryBuilder().schema("A", z.string());
    expect(() => builder.schema("A", z.number())).toThrow(
      DuplicateContractError,
    );
  });

  it("refuses a duplicate path", () => {
    const item = { get: { operationId: "a", summary: "", responses: {} } };
    const builder = new RegistryBuilder().path("/a", item);
    expect(() => builder.path("/a", item)).toThrow(DuplicateContractError);
  });

  it("refuses an operation referencing an unregistered schema", () => {
    const builder = new RegistryBuilder().path("/a", {
      get: {
        operationId: "getA",
        summary: "",
        responses: { "200": { description: "ok", schema: "Missing" } },
      },
    });
    expect(() => builder.build()).toThrow(UnregisteredSchemaError);
  });

  it("refuses a request body referencing an unregistered schema", () => {
    const builder = new RegistryBuilder().path("/a", {
      post: {
        operationId: "postA",
        summary: "",
        requestBody: "Missing",
        responses: {},
      },
    });
    expect(() => builder.build()).toThrow(/references schema "Missing"/);
  });

  it("builds when every reference resolves", () => {
    const registry = new RegistryBuilder()
      .schema("A", z.object({ a: z.string() }))
      .path("/a", {
        get: {
          operationId: "getA",
          summary: "Get A",
          responses: { "200": { description: "ok", schema: "A" } },
        },
      })
      .build();
    expect([...registry.schemas.keys()]).toEqual(["A"]);
    expect([...registry.paths.keys()]).toEqual(["/a"]);
  });
});
