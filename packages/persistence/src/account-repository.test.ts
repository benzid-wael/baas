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
import { AccountRepository } from "./account-repository.js";
import { DECLARED_SCHEMA } from "./schema.js";

let harness: DatabaseHarness;
let scope: TenantScope;
let customers: CustomerRepository;
let accounts: AccountRepository;

const ACME = uuidv7();
const RIVAL = uuidv7();
const START = parseInstant("2026-09-27T11:00:00.000Z");
const ALICE = "0192f3a4-5b6c-7d8e-8f90-1234567890ab";
const BOB = "0192f3a4-5b6c-7d8e-8f90-1234567890cd";

let alice: string;
let bob: string;

beforeAll(async () => {
  harness = await startDatabase({
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
  });
  scope = new TenantScope(harness.db);
  const ids = new SequenceIdGenerator(
    Array.from({ length: 600 }, () => uuidv7()),
  );
  customers = new CustomerRepository(new TestClock(START), ids);
  accounts = new AccountRepository(new TestClock(START), ids);

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
  await harness.db.deleteFrom("account").execute();
  await sql`SET session_replication_role = origin`.execute(harness.db);
  await harness.db.deleteFrom("customer").execute();

  alice = (await scope.run(ACME, (db) => customers.register(db, ACME, ALICE)))
    .id;
  bob = (await scope.run(ACME, (db) => customers.register(db, ACME, BOB))).id;
});

function observed(
  customerId: string,
  reference: string,
  over: Record<string, unknown> = {},
) {
  return {
    customerId,
    providerId: "keel",
    accountReference: reference,
    product: "current_account" as const,
    currency: "AED",
    status: "active" as const,
    iban: `AE07033123456789${reference}`,
    ...over,
  };
}

async function sync(reference: string, customerId: string, over = {}) {
  await scope.runAsProviderSync(ACME, (db) =>
    accounts.observe(db, ACME, observed(customerId, reference, over)),
  );
}

describe("an account is what an account is", () => {
  it("has no balance column at all", () => {
    // The provider is authoritative for how much money exists. A stored
    // balance is a cache that will be wrong and will be believed.
    for (const column of DECLARED_SCHEMA["account"] ?? []) {
      expect(column).not.toMatch(/balance/i);
    }
  });

  it("round-trips its reference and lifecycle", async () => {
    await sync("ACC-1", alice);
    const [account] = await scope.run(ACME, (db) =>
      accounts.listForCustomer(db, alice),
    );
    expect(account).toMatchObject({
      providerId: "keel",
      accountReference: "ACC-1",
      product: "current_account",
      currency: "AED",
      status: "active",
    });
    expect(account?.observedAt).toBeInstanceOf(Date);
  });

  it("updates on re-observation rather than duplicating", async () => {
    await sync("ACC-1", alice);
    await sync("ACC-1", alice, {
      status: "frozen",
      statusReason: "under review",
    });

    const list = await scope.run(ACME, (db) =>
      accounts.listForCustomer(db, alice),
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      status: "frozen",
      statusReason: "under review",
    });
  });
});

describe("an account belongs to exactly one customer", () => {
  it("lists only that customer's accounts", async () => {
    await sync("ACC-1", alice);
    await sync("ACC-2", bob);

    const hers = await scope.run(ACME, (db) =>
      accounts.listForCustomer(db, alice),
    );
    expect(hers.map((a) => a.accountReference)).toEqual(["ACC-1"]);
  });

  it("refuses another customer's reference rather than returning it", async () => {
    // The customer id is part of the query, not a check afterwards. A check
    // after the fact is one somebody eventually forgets.
    await sync("ACC-2", bob);
    expect(
      await scope.run(ACME, (db) =>
        accounts.forCustomerByReference(db, alice, "ACC-2"),
      ),
    ).toBeUndefined();
  });

  it("finds an account the customer does own", async () => {
    await sync("ACC-1", alice);
    expect(
      await scope.run(ACME, (db) =>
        accounts.forCustomerByReference(db, alice, "ACC-1"),
      ),
    ).toMatchObject({ accountReference: "ACC-1" });
  });
});

describe("accounts are derived state", () => {
  it("refuses a write from an ordinary request scope", async () => {
    await expect(
      scope.run(ACME, (db) =>
        accounts.observe(db, ACME, observed(alice, "ACC-9")),
      ),
    ).rejects.toThrow(/only permitted inside a provider sync/);
  });

  it("is tenant-isolated", async () => {
    await sync("ACC-1", alice);
    const seenByRival = await scope.run(RIVAL, (db) =>
      db.selectFrom("account").selectAll().execute(),
    );
    expect(seenByRival).toEqual([]);
  });

  it("refuses to move an account reference between customers", async () => {
    // Silently keeping the old owner while refreshing every other field is
    // the worst outcome: ownership stale, everything else current.
    await sync("ACC-1", alice);
    await expect(sync("ACC-1", bob)).rejects.toThrow(
      /already held by a different customer/,
    );

    const stillHers = await scope.run(ACME, (db) =>
      accounts.listForCustomer(db, alice),
    );
    expect(stillHers.map((a) => a.accountReference)).toEqual(["ACC-1"]);
  });
});
