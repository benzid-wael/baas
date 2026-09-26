import { describe, expect, it } from "vitest";
import {
  IrreversibleMigrationError,
  MalformedMigrationError,
  parseMigration,
} from "./migrator.js";

describe("migration files", () => {
  it("parses up and down sections", () => {
    const migration = parseMigration(
      "0001_x.sql",
      "-- migrate:up\nCREATE TABLE a ();\n\n-- migrate:down\nDROP TABLE a;\n",
    );
    expect(migration.up).toBe("CREATE TABLE a ();");
    expect(migration.down).toBe("DROP TABLE a;");
    expect(migration.irreversibleReason).toBeUndefined();
  });

  it("accepts an irreversible migration that states why", () => {
    const migration = parseMigration(
      "0002_x.sql",
      "-- irreversible: the dropped column's values are not recoverable\n-- migrate:up\nALTER TABLE a DROP COLUMN b;\n",
    );
    expect(migration.down).toBeUndefined();
    expect(migration.irreversibleReason).toBe(
      "the dropped column's values are not recoverable",
    );
  });

  it("refuses an irreversible migration with no reason", () => {
    // Requiring a reason rather than allowing silence means an irreversible
    // migration is a decision somebody wrote down.
    expect(() =>
      parseMigration("0003_x.sql", "-- migrate:up\nDROP TABLE a;\n"),
    ).toThrow(MalformedMigrationError);
  });

  it("refuses a migration with no up section", () => {
    expect(() =>
      parseMigration("0004_x.sql", "-- migrate:down\nDROP TABLE a;"),
    ).toThrow(/no `-- migrate:up`/);
  });

  it("refuses a migration that is both reversible and irreversible", () => {
    expect(() =>
      parseMigration(
        "0005_x.sql",
        "-- irreversible: because\n-- migrate:up\nA;\n-- migrate:down\nB;\n",
      ),
    ).toThrow(/and also provides a down section/);
  });

  it("names the migration in every error, so the file is obvious", () => {
    expect(() => parseMigration("0006_x.sql", "")).toThrow(/0006_x\.sql/);
  });

  it("describes an irreversible rollback as forward-only", () => {
    expect(
      new IrreversibleMigrationError("0002_x.sql", "data loss").message,
    ).toContain("The fix is forward");
  });
});
