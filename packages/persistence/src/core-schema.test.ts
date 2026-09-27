import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { parseInstant, toJsDate } from "@baas/platform";
import { startDatabase } from "./harness.js";
import { assertSchemaMatches, compareSchema } from "./introspect.js";
import { loadMigrations } from "./migrator.js";
import type { DatabaseHarness } from "./harness.js";

/**
 * Persistence tests run against real PostgreSQL, started by the test run.
 *
 * There is deliberately no `describe.skipIf(!process.env.DATABASE_URL)` here.
 * Finding E1: 33 specs skip without a database URL and 521 tests skip in the
 * default loop, and that is the layer where the quarter's real defects lived.
 * If the database cannot start, this file fails.
 */
let harness: DatabaseHarness;

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

beforeAll(async () => {
  harness = await startDatabase({ migrationsDir: MIGRATIONS_DIR });
}, 120_000);

afterAll(async () => {
  await harness.stop();
});

const tenantId = uuidv7();

/** Fixed, so a row written by these tests is reproducible. */
const AT = toJsDate(parseInstant("2026-09-26T12:00:00.000Z"));

describe("migrations", () => {
  it("records what it applied", async () => {
    const rows = await harness.db
      .selectFrom("schema_migration")
      .selectAll()
      .execute();
    // Derived, not listed: a hardcoded list makes every new migration break
    // two unrelated tests, which teaches people to edit assertions reflexively.
    expect(rows.map((row) => row.id)).toEqual(
      loadMigrations(MIGRATIONS_DIR).map((migration) => migration.id),
    );
    expect(rows[0]?.applied_at).toBeInstanceOf(Date);
  });

  it("is idempotent — a second run applies nothing", async () => {
    const second = await startDatabase({
      migrationsDir: MIGRATIONS_DIR,
      databaseUrl: harness.url,
    });
    const rows = await second.db
      .selectFrom("schema_migration")
      .selectAll()
      .execute();
    expect(rows).toHaveLength(loadMigrations(MIGRATIONS_DIR).length);
    await second.stop();
  });
});

describe("tenancy substrate", () => {
  it("stores a tenant and an api client bound to it", async () => {
    await harness.db
      .insertInto("tenant")
      .values({
        id: tenantId,
        slug: "superchat",
        name: "Superchat",
        created_at: AT,
      })
      .execute();

    const clientId = uuidv7();
    await harness.db
      .insertInto("api_client")
      .values({
        id: clientId,
        tenant_id: tenantId,
        client_id: "mobile-bff",
        secret_hash: "$2b$10$notarealhash",
        name: "Mobile BFF",
        disabled_at: null,
        created_at: AT,
      })
      .execute();

    const found = await harness.db
      .selectFrom("api_client")
      .selectAll()
      .where("client_id", "=", "mobile-bff")
      .executeTakeFirstOrThrow();
    expect(found.tenant_id).toBe(tenantId);
  });

  it("refuses an api client with no tenant", async () => {
    await expect(
      harness.db
        .insertInto("api_client")
        .values({
          id: uuidv7(),
          tenant_id: uuidv7(),
          client_id: "orphan",
          secret_hash: "x",
          name: "Orphan",
          disabled_at: null,
          created_at: AT,
        })
        .execute(),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe("scope changes are append-only and audited (D2)", () => {
  it("permits one live grant per scope and allows re-granting after revocation", async () => {
    const client = uuidv7();
    await harness.db
      .insertInto("api_client")
      .values({
        id: client,
        tenant_id: tenantId,
        client_id: `scoped-${client.slice(0, 8)}`,
        secret_hash: "x",
        name: "Scoped",
        disabled_at: null,
        created_at: AT,
      })
      .execute();

    const grant = {
      api_client_id: client,
      scope: "mobile:accounts",
      granted_at: AT,
      granted_by: tenantId,
      revoked_at: null,
      revoked_by: null,
      reason: "initial",
    };

    await harness.db
      .insertInto("api_client_scope")
      .values({ id: uuidv7(), ...grant })
      .execute();

    // A second live grant of the same scope is a duplicate, not an update.
    await expect(
      harness.db
        .insertInto("api_client_scope")
        .values({ id: uuidv7(), ...grant })
        .execute(),
    ).rejects.toThrow(/duplicate key/i);

    // Revoking leaves the history and frees the scope to be granted again.
    await harness.db
      .updateTable("api_client_scope")
      .set({ revoked_at: AT, revoked_by: tenantId })
      .where("api_client_id", "=", client)
      .execute();

    await harness.db
      .insertInto("api_client_scope")
      .values({ id: uuidv7(), ...grant, reason: "re-granted" })
      .execute();

    const history = await harness.db
      .selectFrom("api_client_scope")
      .selectAll()
      .where("api_client_id", "=", client)
      .execute();
    expect(history).toHaveLength(2);
  });
});

describe("audit is immutable", () => {
  it("accepts an insert", async () => {
    await harness.db
      .insertInto("audit_event")
      .values({
        id: uuidv7(),
        tenant_id: tenantId,
        occurred_at: AT,
        actor_id: null,
        actor_kind: "system",
        action: "tenant.created",
        subject_type: "tenant",
        subject_id: tenantId,
        detail: JSON.stringify({ slug: "superchat" }),
      })
      .execute();
    const rows = await harness.db
      .selectFrom("audit_event")
      .selectAll()
      .execute();
    expect(rows.length).toBeGreaterThan(0);
  });

  it("refuses an update or a delete, by trigger rather than by grant", async () => {
    // A grant would not hold for the superuser connection the service
    // actually uses, so the rule is enforced where it cannot be bypassed.
    await expect(
      harness.db
        .updateTable("audit_event")
        .set({ action: "tampered" })
        .execute(),
    ).rejects.toThrow(/append-only/);
    await expect(
      harness.db.deleteFrom("audit_event").execute(),
    ).rejects.toThrow(/append-only/);
  });
});

describe("row-level security is written and tested now", () => {
  /**
   * Two things had to be got right before these assertions meant anything,
   * and both were wrong first:
   *
   * 1. The harness connects as the initdb user, which is a superuser, and a
   *    superuser bypasses RLS entirely — even under FORCE ROW LEVEL SECURITY.
   *    The policy was never exercised. `SET ROLE` fixes that.
   * 2. `set_config(name, value, false)` is **session**-scoped. On a pooled
   *    connection the setting outlives the request that set it, so the next
   *    request on that connection inherits the previous tenant's context.
   *    The third argument must be `true` — transaction-local — and the
   *    statement must run inside a transaction. See New-14.
   */
  it("isolates by app.tenant_id, as a non-superuser", async () => {
    const other = uuidv7();
    await harness.db
      .insertInto("tenant")
      .values({
        id: other,
        slug: "other",
        name: "Other",
        created_at: AT,
      })
      .execute();

    await harness.db.connection().execute(async (conn) => {
      await sql`CREATE ROLE rls_probe NOLOGIN`.execute(conn);
      await sql`GRANT SELECT ON audit_event TO rls_probe`.execute(conn);

      await conn.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE rls_probe`.execute(trx);
        await sql`SELECT set_config('app.tenant_id', ${other}, true)`.execute(
          trx,
        );
        expect(
          await trx.selectFrom("audit_event").selectAll().execute(),
        ).toEqual([]);
      });

      await conn.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE rls_probe`.execute(trx);
        await sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`.execute(
          trx,
        );
        const own = await trx.selectFrom("audit_event").selectAll().execute();
        expect(own.length).toBeGreaterThan(0);
        expect(own.every((row) => row.tenant_id === tenantId)).toBe(true);
      });

      await sql`DROP OWNED BY rls_probe`.execute(conn);
      await sql`DROP ROLE rls_probe`.execute(conn);
    });
  });

  it("shows nothing when app.tenant_id is unset, rather than everything", async () => {
    // Deny by default: an unset setting must not read as "no filter". This
    // also proves the leak in New-14 is closed, because a transaction-local
    // setting from the previous test cannot still be in force here.
    await harness.db.connection().execute(async (conn) => {
      await sql`CREATE ROLE rls_probe2 NOLOGIN`.execute(conn);
      await sql`GRANT SELECT ON audit_event TO rls_probe2`.execute(conn);

      await conn.transaction().execute(async (trx) => {
        await sql`SET LOCAL ROLE rls_probe2`.execute(trx);
        expect(
          await trx.selectFrom("audit_event").selectAll().execute(),
        ).toEqual([]);
      });

      await sql`DROP OWNED BY rls_probe2`.execute(conn);
      await sql`DROP ROLE rls_probe2`.execute(conn);
    });
  });
});

describe("schema drift (T5, finding A4)", () => {
  it("declarations and the migrated database agree", async () => {
    await expect(assertSchemaMatches(harness.db)).resolves.toBeUndefined();
  });

  it("catches a column created by SQL that nothing declares", async () => {
    // The incumbent's exact defect: `reconciliationId` was created by a
    // migration, written by raw SQL, and declared by no entity.
    await sql`ALTER TABLE tenant ADD COLUMN reconciliation_id uuid`.execute(
      harness.db,
    );
    await expect(assertSchemaMatches(harness.db)).rejects.toThrow(
      /tenant\.reconciliation_id exists but is not declared/,
    );
    await sql`ALTER TABLE tenant DROP COLUMN reconciliation_id`.execute(
      harness.db,
    );
  });

  it("catches a declaration with no column behind it", () => {
    const report = compareSchema(
      [{ table: "tenant", column: "id", nullable: false }],
      { tenant: ["id", "ghost"] },
    );
    expect(report.missing).toEqual(["tenant.ghost"]);
  });

  it("catches a whole table in either direction", () => {
    expect(
      compareSchema([{ table: "extra", column: "id", nullable: false }], {})
        .undeclared,
    ).toEqual(["extra (whole table)"]);
    expect(compareSchema([], { ghost: ["id"] }).missing).toEqual([
      "ghost (whole table)",
    ]);
  });
});
