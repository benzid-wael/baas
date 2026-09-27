import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { parseInstant, toJsDate } from "@baas/platform";
import { startDatabase } from "./harness.js";
import type { DatabaseHarness } from "./harness.js";
import { TenantScope } from "./tenant-scope.js";

let harness: DatabaseHarness;
let scope: TenantScope;

const ACME = uuidv7();
const RIVAL = uuidv7();
const AT = toJsDate(parseInstant("2026-09-27T09:00:00.000Z"));

beforeAll(async () => {
  harness = await startDatabase({
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
  });
  scope = new TenantScope(harness.db);

  for (const [id, slug] of [
    [ACME, "acme"],
    [RIVAL, "rival"],
  ] as const) {
    await harness.db
      .insertInto("tenant")
      .values({ id, slug, name: slug, created_at: AT })
      .execute();
  }
}, 120_000);

afterAll(async () => {
  await harness.stop();
});

function auditRow(tenantId: string, action: string) {
  return {
    id: uuidv7(),
    tenant_id: tenantId,
    occurred_at: AT,
    actor_id: null,
    actor_kind: "system",
    action,
    subject_type: "tenant",
    subject_id: tenantId,
    detail: JSON.stringify({}),
  };
}

beforeEach(async () => {
  // TRUNCATE, not DELETE: the append-only trigger raises on DELETE for every
  // row, which is the point of it. TRUNCATE does not fire row triggers and
  // needs table ownership, so a test can reset the table and the application
  // role still cannot.
  await sql`TRUNCATE audit_event`.execute(harness.db);
});

describe("a tenant scope isolates", () => {
  beforeEach(async () => {
    await scope.run(ACME, (db) =>
      db
        .insertInto("audit_event")
        .values(auditRow(ACME, "acme.event"))
        .execute(),
    );
    await scope.run(RIVAL, (db) =>
      db
        .insertInto("audit_event")
        .values(auditRow(RIVAL, "rival.event"))
        .execute(),
    );
  });

  it("shows a tenant only its own rows", async () => {
    const acme = await scope.run(ACME, (db) =>
      db.selectFrom("audit_event").selectAll().execute(),
    );
    expect(acme.map((row) => row.action)).toEqual(["acme.event"]);

    const rival = await scope.run(RIVAL, (db) =>
      db.selectFrom("audit_event").selectAll().execute(),
    );
    expect(rival.map((row) => row.action)).toEqual(["rival.event"]);
  });

  it("does not leak across consecutive scopes on a pooled connection", async () => {
    // New-14. `set_config(..., false)` is session-scoped, so on a pooled
    // connection the previous request's tenant survives into the next one.
    // Running the two scopes back to back is what exposed it.
    for (let round = 0; round < 5; round += 1) {
      const acme = await scope.run(ACME, (db) =>
        db.selectFrom("audit_event").selectAll().execute(),
      );
      const rival = await scope.run(RIVAL, (db) =>
        db.selectFrom("audit_event").selectAll().execute(),
      );
      expect(acme).toHaveLength(1);
      expect(rival).toHaveLength(1);
      expect(acme[0]?.tenant_id).toBe(ACME);
      expect(rival[0]?.tenant_id).toBe(RIVAL);
    }
  });

  it("does not leak when a scope aborts", async () => {
    await expect(
      scope.run(RIVAL, async (db) => {
        await db.selectFrom("audit_event").selectAll().execute();
        throw new Error("handler failed");
      }),
    ).rejects.toThrow("handler failed");

    const acme = await scope.run(ACME, (db) =>
      db.selectFrom("audit_event").selectAll().execute(),
    );
    expect(acme.map((row) => row.tenant_id)).toEqual([ACME]);
  });

  it("releases both the role and the setting when the scope ends", async () => {
    await scope.run(ACME, () => Promise.resolve());
    const after = await sql<{ role: string; tenant: string | null }>`
      SELECT current_user AS role,
             nullif(current_setting('app.tenant_id', true), '') AS tenant
    `.execute(harness.db);
    expect(after.rows[0]?.role).not.toBe("baas_app");
    expect(after.rows[0]?.tenant).toBeNull();
  });

  it("writes are scoped too, not only reads", async () => {
    // A write carrying another tenant's id must be refused by the policy
    // rather than silently attributed.
    await expect(
      scope.run(ACME, (db) =>
        db
          .insertInto("audit_event")
          .values(auditRow(RIVAL, "smuggled"))
          .execute(),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("row-level security applies to the owner", () => {
  it("is FORCEd, so a deployment connecting as the owner is still isolated", async () => {
    // Without FORCE the table owner is exempt, so the policies would be in
    // place and isolation would not exist.
    const forced = await sql<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE relname = 'audit_event'
    `.execute(harness.db);
    expect(forced.rows[0]).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
  });
});

describe("registry tables are readable without a tenant", () => {
  it("api_client can be read before the tenant is known", async () => {
    // Reading it is *how* the tenant is established, so a policy requiring the
    // tenant to already be known would be unsatisfiable. 0003 removes it.
    const policies = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM pg_policies WHERE tablename = 'api_client'
    `.execute(harness.db);
    expect(policies.rows[0]?.count).toBe("0");

    const tenants = await scope.registry((db) =>
      db.selectFrom("tenant").selectAll().execute(),
    );
    expect(tenants.length).toBeGreaterThanOrEqual(2);
  });
});
