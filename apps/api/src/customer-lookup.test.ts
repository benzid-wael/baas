import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { uuidv7 } from "uuidv7";
import {
  SequenceIdGenerator,
  TestClock,
  parseInstant,
  toJsDate,
} from "@baas/platform";
import { CustomerRepository, TenantScope } from "@baas/persistence";
import { startDatabase } from "@baas/persistence/testing";
import type { DatabaseHarness } from "@baas/persistence/testing";
import { RegistryCustomerLookup } from "./customer-lookup.js";

let harness: DatabaseHarness;
let lookup: RegistryCustomerLookup;
let scope: TenantScope;
let repository: CustomerRepository;

const ACME = uuidv7();
const RIVAL = uuidv7();
const START = parseInstant("2026-09-27T10:00:00.000Z");
const USER = "0192f3a4-5b6c-7d8e-8f90-1234567890ab";

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
  repository = new CustomerRepository(
    new TestClock(START),
    new SequenceIdGenerator(Array.from({ length: 100 }, () => uuidv7())),
  );
  lookup = new RegistryCustomerLookup(scope, repository);

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
  await harness.db.deleteFrom("customer").execute();
});

describe("the guard chain resolves a real customer", () => {
  it("finds one registered for that tenant", async () => {
    const registered = await scope.run(ACME, (db) =>
      repository.register(db, ACME, USER),
    );
    expect(await lookup.byExternalUuid(ACME, USER)).toEqual({
      customerId: registered.id,
    });
  });

  it("returns nothing for an unknown user", async () => {
    expect(await lookup.byExternalUuid(ACME, USER)).toBeUndefined();
  });

  it("will not resolve another tenant's customer, even with the right uuid", async () => {
    // The tenant comes from the credential, not the request. Knowing a valid
    // external uuid must not be enough to reach the customer behind it.
    await scope.run(ACME, (db) => repository.register(db, ACME, USER));
    expect(await lookup.byExternalUuid(RIVAL, USER)).toBeUndefined();
  });
});
