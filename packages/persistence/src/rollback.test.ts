import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { sql } from "kysely";
import { startDatabase } from "./harness.js";
import type { DatabaseHarness } from "./harness.js";
import { SystemClock } from "@baas/platform";
import { loadMigrations, migrateDown, migrateUp } from "./migrator.js";
import type { MigratableDatabase } from "./migrator.js";
import type { Kysely } from "kysely";

/**
 * CI gate 5: every migration applies and, where reversible, rolls back.
 *
 * Rolling all the way down and back up is what catches a `down` section that
 * drops objects in the wrong order, or forgets one — which is invisible until
 * the day somebody needs it.
 */
let harness: DatabaseHarness;
const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

/** Kysely's schema generic is invariant; narrowed once for the migrator. */
const migratable = (): Kysely<MigratableDatabase> =>
  harness.db as unknown as Kysely<MigratableDatabase>;

beforeAll(async () => {
  harness = await startDatabase({ migrationsDir: MIGRATIONS_DIR });
}, 120_000);

afterAll(async () => {
  await harness.stop();
});

describe("migrations round-trip", () => {
  it("rolls every migration down and back up", async () => {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    expect(migrations.length).toBeGreaterThan(0);

    for (let index = 0; index < migrations.length; index += 1) {
      const rolled = await migrateDown(migratable(), migrations);
      expect(rolled).toBeDefined();
    }

    const empty = await harness.db
      .selectFrom("schema_migration")
      .selectAll()
      .execute();
    expect(empty).toEqual([]);

    const tables = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name <> 'schema_migration'
    `.execute(harness.db);
    expect(tables.rows[0]?.count).toBe("0");

    const result = await migrateUp(migratable(), migrations, new SystemClock());
    expect(result.applied).toEqual(migrations.map((m) => m.id));
  });

  it("every migration is reversible or says why it is not", () => {
    for (const migration of loadMigrations(MIGRATIONS_DIR)) {
      const declared =
        migration.down !== undefined ||
        migration.irreversibleReason !== undefined;
      expect(declared, `${migration.id} declares neither`).toBe(true);
    }
  });
});
