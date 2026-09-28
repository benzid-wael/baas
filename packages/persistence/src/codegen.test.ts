import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "prettier";
import {
  UnmappedColumnTypeError,
  introspectForCodegen,
  parseEnumCheck,
  renderSchemaModule,
} from "./codegen.js";
import type { TableShape } from "./codegen.js";
import { startDatabase } from "./harness.js";
import type { DatabaseHarness } from "./harness.js";

/**
 * Generating the database types (New-15).
 *
 * The rendering is pure, so most of this needs no database. The one test that
 * does is the one that matters: **the checked-in file is what a freshly
 * migrated database produces**, which is what stops it drifting.
 */
let harness: DatabaseHarness;
const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

beforeAll(async () => {
  harness = await startDatabase({ migrationsDir: MIGRATIONS });
}, 120_000);

afterAll(async () => {
  await harness.stop();
});

describe("the checked-in types are the generated ones", () => {
  it("matches a freshly migrated database, byte for byte", async () => {
    // The criterion: CI regenerates and fails on a diff. If this fails, run
    // `pnpm db:types` — do not edit the generated file.
    const tables = await introspectForCodegen(harness.db);
    const rendered = await format(renderSchemaModule(tables), {
      parser: "typescript",
    });
    const checkedIn = readFileSync(
      join(import.meta.dirname, "schema.generated.ts"),
      "utf8",
    );
    expect(rendered).toBe(checkedIn);
  });

  it("reads the unions out of the CHECK constraints", async () => {
    // The duplication nothing was checking: a TypeScript union beside a
    // `CHECK (x IN (…))`, able to disagree silently.
    const tables = await introspectForCodegen(harness.db);
    const outbox = tables.find((table) => table.name === "effect_outbox");
    const state = outbox?.columns.find((column) => column.name === "state");
    expect(state?.enumValues).toEqual([
      "pending",
      "dispatched",
      "confirmed",
      "failed",
      "unknown",
    ]);
  });

  it("carries a COMMENT ON through to the type", async () => {
    const tables = await introspectForCodegen(harness.db);
    const log = tables.find((table) => table.name === "provider_request_log");
    const body = log?.columns.find((column) => column.name === "request_body");
    expect(body?.comment).toMatch(/classification: restricted/);
  });

  it("records nullability from the database, not from a guess", async () => {
    const tables = await introspectForCodegen(harness.db);
    const account = tables.find((table) => table.name === "account");
    expect(
      account?.columns.find((column) => column.name === "id")?.nullable,
    ).toBe(false);
    expect(
      account?.columns.find((column) => column.name === "iban")?.nullable,
    ).toBe(true);
  });
});

describe("rendering", () => {
  const table = (columns: TableShape["columns"]): TableShape[] => [
    { name: "widget", columns },
  ];

  it("maps each type the schema actually uses", () => {
    const rendered = renderSchemaModule(
      table([
        { name: "a", dataType: "uuid", nullable: false },
        { name: "b", dataType: "text", nullable: false },
        { name: "c", dataType: "boolean", nullable: false },
        { name: "d", dataType: "integer", nullable: false },
        { name: "e", dataType: "bigint", nullable: false },
        { name: "f", dataType: "timestamp with time zone", nullable: false },
        { name: "g", dataType: "jsonb", nullable: false },
      ]),
    );
    expect(rendered).toContain("a: string;");
    expect(rendered).toContain("c: boolean;");
    expect(rendered).toContain("d: number;");
    // `pg` returns int8 as a string because it does not fit a number, which is
    // also why money is bigint minor units.
    expect(rendered).toContain("e: string;");
    expect(rendered).toContain("f: Date;");
    expect(rendered).toContain("g: unknown;");
  });

  it("refuses a type nobody has mapped", () => {
    // Defaulting to `unknown` would let a column slip into the model as
    // something the compiler cannot check, which is the failure this file
    // exists to prevent.
    expect(() =>
      renderSchemaModule(
        table([{ name: "a", dataType: "tsvector", nullable: false }]),
      ),
    ).toThrow(UnmappedColumnTypeError);
  });

  it("names the column and the type it could not map", () => {
    try {
      renderSchemaModule(
        table([{ name: "body", dataType: "tsvector", nullable: false }]),
      );
      throw new Error("expected it to refuse");
    } catch (error) {
      expect((error as Error).message).toContain("widget.body");
      expect((error as Error).message).toContain("tsvector");
    }
  });

  it("makes a nullable column nullable", () => {
    expect(
      renderSchemaModule(
        table([{ name: "a", dataType: "text", nullable: true }]),
      ),
    ).toContain("a: string | null;");
  });

  it("uses the union for a column that has one", () => {
    const rendered = renderSchemaModule(
      table([
        {
          name: "state",
          dataType: "text",
          nullable: false,
          enumValues: ["on", "off"],
        },
      ]),
    );
    expect(rendered).toContain("export type WidgetState =");
    expect(rendered).toContain("state: WidgetState;");
  });

  it("puts every table in the Database interface and in DECLARED_SCHEMA", () => {
    const rendered = renderSchemaModule([
      {
        name: "one",
        columns: [{ name: "id", dataType: "uuid", nullable: false }],
      },
      {
        name: "two",
        columns: [{ name: "id", dataType: "uuid", nullable: false }],
      },
    ]);
    expect(rendered).toContain("one: OneTable;");
    expect(rendered).toContain("two: TwoTable;");
    expect(rendered).toMatch(/DECLARED_SCHEMA[\s\S]*one: \[/);
    expect(rendered).toMatch(/DECLARED_SCHEMA[\s\S]*two: \[/);
  });
});

describe("reading a CHECK constraint", () => {
  const anyOf = (column: string, values: string[]) =>
    `CHECK ((${column} = ANY (ARRAY[${values.map((v) => `'${v}'::text`).join(", ")}])))`;

  it("reads the values out", () => {
    expect(parseEnumCheck(anyOf("state", ["a", "b"]), "state")).toEqual([
      "a",
      "b",
    ]);
  });

  it("ignores a constraint about a different column", () => {
    expect(parseEnumCheck(anyOf("state", ["a"]), "status")).toBeUndefined();
  });

  it("ignores a constraint that is not an enumeration", () => {
    // `CHECK (char_length(currency) = 3)` is a real constraint and says
    // nothing about which values are permitted.
    expect(
      parseEnumCheck("CHECK ((char_length(currency) = 3))", "currency"),
    ).toBeUndefined();
    expect(
      parseEnumCheck("CHECK ((duration_ms >= 0))", "duration_ms"),
    ).toBeUndefined();
  });
});
