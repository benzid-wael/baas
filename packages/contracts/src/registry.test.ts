import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DuplicateContractError,
  RegistryBuilder,
  UnregisteredSchemaError,
} from "./registry.js";
import { buildRegistry } from "./contracts.js";

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

/**
 * Every success response names a schema (New-27, correction C16).
 *
 * A path published with a description and no schema is a path whose consumers
 * each invent a type — and the inventions type-check. That is not a
 * hypothetical: `/platform/customers` shipped that way, the portal declared
 * `links` where the service returns `providers`, both compiled, and a `curl`
 * found it.
 *
 * The route-drift check (New-12) cannot catch this. It compares *paths*, and
 * the path was right.
 */
describe("every published success response has a shape", () => {
  it("names a schema for each 2xx", () => {
    const naked: string[] = [];
    for (const [path, item] of buildRegistry().paths) {
      for (const [method, operation] of Object.entries(item)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          if (status.startsWith("2") && response.schema === undefined) {
            naked.push(`${method.toUpperCase()} ${path} → ${status}`);
          }
        }
      }
    }
    expect(naked).toEqual([]);
  });

  it("refuses a schema name nothing registered", () => {
    // Already enforced by the builder; asserted here so the rule above cannot
    // be satisfied by naming a schema that does not exist.
    expect(() =>
      new RegistryBuilder()
        .path("/x", {
          get: {
            operationId: "x",
            summary: "x",
            responses: { "200": { description: "x", schema: "NotRegistered" } },
          },
        })
        .build(),
    ).toThrow();
  });
});
