import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { Duration } from "@baas/domain";
import {
  SequenceIdGenerator,
  TestClock,
  createLogger,
  parseInstant,
  toJsDate,
} from "@baas/platform";
import {
  AccountRepository,
  BalanceRepository,
  TenantScope,
} from "@baas/persistence";
import { startDatabase } from "@baas/persistence/testing";
import type { DatabaseHarness } from "@baas/persistence/testing";
import { ReadAccounts, ReadBalance } from "@baas/application";
import { SeedRefusedError, seedDemoData } from "@baas/api";

/**
 * The demo customer (New-25).
 *
 * The assertion worth making is not "rows exist" — it is that reading them
 * back through `ReadAccounts` produces **all three balance shapes**. Finding
 * F4 is a screen built against one shape rendering the other two as a
 * confident `0.00`, and demo data that only ever produces one shape would let
 * exactly that be built.
 */
const START = parseInstant("2026-09-28T12:00:00.000Z");
const TENANT = uuidv7();
const logger = createLogger({
  service: "t",
  environment: "test",
  level: "silent",
});

let harness: DatabaseHarness;
let scope: TenantScope;

function ids(): SequenceIdGenerator {
  return new SequenceIdGenerator(Array.from({ length: 200 }, () => uuidv7()));
}

beforeAll(async () => {
  harness = await startDatabase({
    migrationsDir: join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "packages",
      "persistence",
      "migrations",
    ),
  });
  scope = new TenantScope(harness.db);
  await harness.db
    .insertInto("tenant")
    .values({ id: TENANT, slug: "sc", name: "SC", created_at: toJsDate(START) })
    .execute();
}, 180_000);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  // `TRUNCATE`, not `DELETE`. `balance_observation` is append-only by row
  // trigger and refuses a delete — truncation does not fire row triggers,
  // which is the same reason the audit tests use it.
  // `CASCADE` because `transaction_projection` also references `account`, and
  // naming every referencing table here would be a list to keep in step with
  // the schema.
  await sql`TRUNCATE balance_observation, account, provider_customer_link, customer CASCADE`.execute(
    harness.db,
  );
});

const seedIt = (clock = new TestClock(START)) =>
  seedDemoData(scope, clock, ids(), { appEnv: "dev", tenantId: TENANT });

describe("the demo customer", () => {
  it("is a customer the identity guard can resolve", async () => {
    const result = await seedIt();
    const found = await scope.run(TENANT, (db) =>
      db
        .selectFrom("customer")
        .selectAll()
        .where("external_user_uuid", "=", result.externalUserUuid)
        .executeTakeFirst(),
    );
    expect(found?.id).toBe(result.customerId);
  });

  it("has three accounts, one per balance shape", async () => {
    const result = await seedIt();
    expect(result.accounts.map((a) => a.accountReference)).toEqual([
      "DEMO-ACCT-RECENT",
      "DEMO-ACCT-OLD",
      "DEMO-ACCT-SILENT",
    ]);
  });

  it("produces all three shapes when read back through the real reader", async () => {
    // Read through `ReadAccounts` with no provider adapter, exactly as a
    // developer would see it: no live provider, so the stored observations are
    // all there is.
    const clock = new TestClock(START);
    const result = await seedIt(clock);
    const reader = new ReadAccounts(
      scope,
      new AccountRepository(clock, ids()),
      new ReadBalance(
        scope,
        new BalanceRepository(clock, ids()),
        new Map(),
        clock,
        logger,
      ),
    );

    const views = await reader.forCustomer(TENANT, result.customerId);
    const byReference = new Map(
      views.map((view) => [view.account.accountReference, view.balance]),
    );

    const recent = byReference.get("DEMO-ACCT-RECENT");
    expect(recent?.kind).toBe("observed");
    // True only because the clock is frozen at seeding time. In a running
    // system this holds for 30 seconds; see the note in `demo-data.ts`.
    expect(recent?.kind === "observed" && recent.fresh).toBe(true);

    const old = byReference.get("DEMO-ACCT-OLD");
    expect(old?.kind).toBe("observed");
    // Served because nothing newer exists, and it says how old it is — the
    // "as of an hour ago" case the UI must render differently.
    expect(old?.kind === "observed" && old.fresh).toBe(false);
    expect(old?.kind === "observed" ? old.age.milliseconds : 0).toBe(
      Duration.ofHours(1).milliseconds,
    );

    const silent = byReference.get("DEMO-ACCT-SILENT");
    // Absent, never zero. Rendering this as 0.00 reads as "you have no money".
    expect(silent).toEqual({ kind: "unavailable", reason: "never_observed" });
  });

  it("uses data that is visibly synthetic", async () => {
    // A developer copying a row out of here into a ticket should be copying
    // something nobody could mistake for a person or an account.
    const result = await seedIt();
    for (const account of result.accounts) {
      expect(account.accountReference).toMatch(/^DEMO-/);
    }
    // A real uuid, because the column is one — but twelve zeros and a one is
    // not something anybody mistakes for a customer's identifier.
    expect(result.externalUserUuid).toMatch(/-0{11}1$/);
  });

  it("refuses to run outside dev", async () => {
    await expect(
      seedDemoData(scope, new TestClock(START), ids(), {
        appEnv: "production",
        tenantId: TENANT,
      }),
    ).rejects.toThrow(SeedRefusedError);
    expect(
      await harness.db.selectFrom("customer").selectAll().execute(),
    ).toEqual([]);
  });
});
