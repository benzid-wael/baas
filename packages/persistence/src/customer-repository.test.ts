import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import {
  SequenceIdGenerator,
  TestClock,
  parseInstant,
  toJsDate,
} from "@baas/platform";
import { startDatabase } from "./harness.js";
import type { DatabaseHarness } from "./harness.js";
import { TenantScope } from "./tenant-scope.js";
import { CustomerRepository } from "./customer-repository.js";

let harness: DatabaseHarness;
let scope: TenantScope;
let repository: CustomerRepository;

const ACME = uuidv7();
const RIVAL = uuidv7();
const START = parseInstant("2026-09-27T10:00:00.000Z");
const USER = "0192f3a4-5b6c-7d8e-8f90-1234567890ab";

beforeAll(async () => {
  harness = await startDatabase({
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
  });
  scope = new TenantScope(harness.db);
  repository = new CustomerRepository(
    new TestClock(START),
    new SequenceIdGenerator(Array.from({ length: 400 }, () => uuidv7())),
  );

  for (const [id, slug] of [
    [ACME, "acme"],
    [RIVAL, "rival"],
  ] as const) {
    await harness.db
      .insertInto("tenant")
      .values({ id, slug, name: slug, created_at: toJsDate(START) })
      .execute();
  }
}, 120_000);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await sql`SET session_replication_role = replica`.execute(harness.db);
  await harness.db.deleteFrom("provider_customer_link").execute();
  await sql`SET session_replication_role = origin`.execute(harness.db);
  await harness.db.deleteFrom("customer").execute();
});

describe("registering a customer", () => {
  it("creates one and finds it again", async () => {
    const created = await scope.run(ACME, (db) =>
      repository.register(db, ACME, USER),
    );
    expect(created.externalUserUuid).toBe(USER);

    const found = await scope.run(ACME, (db) =>
      repository.byExternalUuid(db, USER),
    );
    expect(found?.id).toBe(created.id);
  });

  it("is idempotent, because two first requests arriving together is normal", async () => {
    const [first, second, third] = await Promise.all([
      scope.run(ACME, (db) => repository.register(db, ACME, USER)),
      scope.run(ACME, (db) => repository.register(db, ACME, USER)),
      scope.run(ACME, (db) => repository.register(db, ACME, USER)),
    ]);
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);

    const all = await harness.db.selectFrom("customer").selectAll().execute();
    expect(all).toHaveLength(1);
  });

  it("keeps the same external uuid separate per tenant", async () => {
    // The same person at two tenants is two customers, and neither can see
    // the other.
    const acme = await scope.run(ACME, (db) =>
      repository.register(db, ACME, USER),
    );
    const rival = await scope.run(RIVAL, (db) =>
      repository.register(db, RIVAL, USER),
    );
    expect(rival.id).not.toBe(acme.id);

    const seenByAcme = await scope.run(ACME, (db) =>
      db.selectFrom("customer").selectAll().execute(),
    );
    expect(seenByAcme.map((row) => row.id)).toEqual([acme.id]);
  });
});

describe("provider links are derived state (D4)", () => {
  it("refuses a write from an ordinary request scope", async () => {
    // The incumbent lets an operator edit link status directly and silently
    // reverts it on the next sync, which is worse than refusing: it looks
    // like it worked.
    const customer = await scope.run(ACME, (db) =>
      repository.register(db, ACME, USER),
    );

    await expect(
      scope.run(ACME, (db) =>
        repository.observeLink(db, ACME, {
          customerId: customer.id,
          providerId: "keel",
          externalCustomerId: "KEEL-1",
          status: "active",
        }),
      ),
    ).rejects.toThrow(/only permitted inside a provider sync/);
  });

  it("refuses a hand-written UPDATE just as firmly", async () => {
    const customer = await scope.run(ACME, (db) =>
      repository.register(db, ACME, USER),
    );
    await scope.runAsProviderSync(ACME, (db) =>
      repository.observeLink(db, ACME, {
        customerId: customer.id,
        providerId: "keel",
        externalCustomerId: "KEEL-1",
        status: "pending",
      }),
    );

    await expect(
      scope.run(ACME, (db) =>
        db
          .updateTable("provider_customer_link")
          .set({ status: "active" })
          .where("customer_id", "=", customer.id)
          .execute(),
      ),
    ).rejects.toThrow(/only permitted inside a provider sync/);
  });

  it("accepts a write inside a provider sync, and updates on re-observation", async () => {
    const customer = await scope.run(ACME, (db) =>
      repository.register(db, ACME, USER),
    );

    await scope.runAsProviderSync(ACME, (db) =>
      repository.observeLink(db, ACME, {
        customerId: customer.id,
        providerId: "keel",
        externalCustomerId: "KEEL-1",
        status: "pending",
      }),
    );
    await scope.runAsProviderSync(ACME, (db) =>
      repository.observeLink(db, ACME, {
        customerId: customer.id,
        providerId: "keel",
        externalCustomerId: "KEEL-1",
        status: "active",
        statusReason: "kyc cleared",
      }),
    );

    const links = await scope.run(ACME, (db) =>
      repository.linksOf(db, customer.id),
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      providerId: "keel",
      status: "active",
      statusReason: "kyc cleared",
    });
  });

  it("does not leave provider-sync permission set after the scope ends", async () => {
    const customer = await scope.run(ACME, (db) =>
      repository.register(db, ACME, USER),
    );
    await scope.runAsProviderSync(ACME, (db) =>
      repository.observeLink(db, ACME, {
        customerId: customer.id,
        providerId: "keel",
        externalCustomerId: "KEEL-1",
        status: "active",
      }),
    );

    // The permission is transaction-local like the tenant, so the next
    // ordinary scope cannot write even on the same pooled connection.
    await expect(
      scope.run(ACME, (db) =>
        db
          .deleteFrom("provider_customer_link")
          .where("customer_id", "=", customer.id)
          .execute(),
      ),
    ).rejects.toThrow(/only permitted inside a provider sync/);
  });

  it("links are tenant-isolated", async () => {
    const customer = await scope.run(ACME, (db) =>
      repository.register(db, ACME, USER),
    );
    await scope.runAsProviderSync(ACME, (db) =>
      repository.observeLink(db, ACME, {
        customerId: customer.id,
        providerId: "keel",
        externalCustomerId: "KEEL-1",
        status: "active",
      }),
    );

    const seenByRival = await scope.run(RIVAL, (db) =>
      db.selectFrom("provider_customer_link").selectAll().execute(),
    );
    expect(seenByRival).toEqual([]);
  });
});
