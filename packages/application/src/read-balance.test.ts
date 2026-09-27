import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { Duration, Money } from "@baas/domain";
import type { AccountReadPort, ProviderBalance } from "@baas/domain";
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
  CustomerRepository,
  TenantScope,
} from "@baas/persistence";
import { startDatabase } from "@baas/persistence/testing";
import type { DatabaseHarness } from "@baas/persistence/testing";
import { ReadBalance } from "./read-balance.js";

const logger = createLogger({
  service: "t",
  environment: "test",
  level: "silent",
});
const TENANT = uuidv7();
const START = parseInstant("2026-09-27T14:00:00.000Z");
const USER = "0192f3a4-5b6c-7d8e-8f90-1234567890ab";

let harness: DatabaseHarness;
let scope: TenantScope;
let balances: BalanceRepository;
let accounts: AccountRepository;
let clock: TestClock;
let accountId: string;

/** A provider that answers, refuses, or is simply absent. */
function providerThat(
  behaviour: "answers" | "throws" | "returns nothing",
  balance?: ProviderBalance,
): AccountReadPort {
  return {
    listAccounts: () => Promise.resolve([]),
    getAccount: () => Promise.resolve(undefined),
    getBalance: () => {
      if (behaviour === "throws") {
        return Promise.reject(new Error("socket hang up"));
      }
      return Promise.resolve(behaviour === "answers" ? balance : undefined);
    },
  };
}

function providerBalance(available: string, at = START): ProviderBalance {
  return {
    accountReference: "ACC-1",
    available: Money.of(available, "AED"),
    current: Money.of(available, "AED"),
    observedAt: at,
  };
}

function reader(provider: AccountReadPort | undefined) {
  return new ReadBalance(
    scope,
    balances,
    provider === undefined ? new Map() : new Map([["keel", provider]]),
    clock,
    logger,
    { freshFor: Duration.ofSeconds(30) },
  );
}

const ACCOUNT = () => ({
  id: accountId,
  providerId: "keel",
  accountReference: "ACC-1",
});

beforeAll(async () => {
  harness = await startDatabase({
    migrationsDir: join(
      import.meta.dirname,
      "..",
      "..",
      "persistence",
      "migrations",
    ),
  });
  scope = new TenantScope(harness.db);
  await harness.db
    .insertInto("tenant")
    .values({ id: TENANT, slug: "t", name: "T", created_at: toJsDate(START) })
    .execute();
}, 120_000);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  clock = new TestClock(START);
  const ids = new SequenceIdGenerator(
    Array.from({ length: 400 }, () => uuidv7()),
  );
  balances = new BalanceRepository(clock, ids);
  accounts = new AccountRepository(clock, ids);
  const customers = new CustomerRepository(clock, ids);

  await sql`SET session_replication_role = replica`.execute(harness.db);
  await harness.db.deleteFrom("balance_observation").execute();
  await harness.db.deleteFrom("account").execute();
  await sql`SET session_replication_role = origin`.execute(harness.db);
  await harness.db.deleteFrom("customer").execute();

  const customer = await scope.run(TENANT, (db) =>
    customers.register(db, TENANT, USER),
  );
  await scope.runAsProviderSync(TENANT, (db) =>
    accounts.observe(db, TENANT, {
      customerId: customer.id,
      providerId: "keel",
      accountReference: "ACC-1",
      product: "current_account",
      currency: "AED",
      status: "active",
    }),
  );
  accountId = (await scope.run(TENANT, (db) =>
    accounts.forCustomerByReference(db, customer.id, "ACC-1"),
  ))!.id;
});

describe("a fresh read", () => {
  it("asks the provider and records what it said", async () => {
    const view = await reader(
      providerThat("answers", providerBalance("1234.50")),
    ).forAccount(TENANT, ACCOUNT());

    expect(view).toMatchObject({ kind: "observed", fresh: true });
    expect(view.kind === "observed" && view.available.toDecimalString()).toBe(
      "1234.50",
    );

    const stored = await scope.run(TENANT, (db) =>
      balances.latest(db, accountId),
    );
    expect(stored?.source).toBe("provider_read");
  });

  it("serves a recent observation without calling the provider again", async () => {
    let calls = 0;
    const provider: AccountReadPort = {
      ...providerThat("answers", providerBalance("100.00")),
      getBalance: () => {
        calls += 1;
        return Promise.resolve(providerBalance("100.00"));
      },
    };

    await reader(provider).forAccount(TENANT, ACCOUNT());
    clock.advanceBy(Duration.ofSeconds(10));
    await reader(provider).forAccount(TENANT, ACCOUNT());
    expect(calls).toBe(1);
  });

  it("asks again once the observation is stale", async () => {
    let calls = 0;
    const provider: AccountReadPort = {
      ...providerThat("answers", providerBalance("100.00")),
      getBalance: () => {
        calls += 1;
        return Promise.resolve(providerBalance("100.00", clock.now()));
      },
    };
    await reader(provider).forAccount(TENANT, ACCOUNT());
    clock.advanceBy(Duration.ofSeconds(31));
    await reader(provider).forAccount(TENANT, ACCOUNT());
    expect(calls).toBe(2);
  });
});

describe("when the provider is unreachable", () => {
  it("serves the last observation, marked stale, with its age", async () => {
    // A retail app showing nothing because a bank is having a bad minute is
    // worse for the customer than one showing a figure and how old it is.
    await reader(
      providerThat("answers", providerBalance("1234.50")),
    ).forAccount(TENANT, ACCOUNT());

    clock.advanceBy(Duration.ofMinutes(11));
    const view = await reader(providerThat("throws")).forAccount(
      TENANT,
      ACCOUNT(),
    );

    expect(view.kind).toBe("observed");
    if (view.kind !== "observed") return;
    expect(view.fresh).toBe(false);
    expect(view.available.toDecimalString()).toBe("1234.50");
    expect(view.age.milliseconds).toBe(11 * 60 * 1000);
  });

  it("says unavailable when there is nothing to fall back to", async () => {
    const view = await reader(providerThat("throws")).forAccount(
      TENANT,
      ACCOUNT(),
    );
    expect(view).toEqual({
      kind: "unavailable",
      reason: "provider_unreachable",
    });
  });

  it("never renders an absent balance as zero", async () => {
    // Finding F4 in its sharpest form: 0.00 reads as "you have no money",
    // which is a worse lie than an error.
    const view = await reader(providerThat("throws")).forAccount(
      TENANT,
      ACCOUNT(),
    );
    expect(JSON.stringify(view)).not.toContain("0.00");
    expect(view.kind === "unavailable").toBe(true);
  });

  it("leaks no provider detail into the view", async () => {
    // The incumbent returns a providerErrors array in a customer-facing
    // response. The detail belongs in the log.
    const view = await reader(providerThat("throws")).forAccount(
      TENANT,
      ACCOUNT(),
    );
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain("socket hang up");
    expect(serialised).not.toContain("keel");
  });

  it("falls back when the adapter is missing entirely", async () => {
    const view = await reader(undefined).forAccount(TENANT, ACCOUNT());
    expect(view).toEqual({
      kind: "unavailable",
      reason: "provider_unreachable",
    });
  });

  it("falls back when the provider answers but has no balance", async () => {
    await reader(providerThat("answers", providerBalance("50.00"))).forAccount(
      TENANT,
      ACCOUNT(),
    );
    clock.advanceBy(Duration.ofMinutes(5));
    const view = await reader(providerThat("returns nothing")).forAccount(
      TENANT,
      ACCOUNT(),
    );
    expect(view).toMatchObject({ kind: "observed", fresh: false });
  });
});

describe("observations are evidence", () => {
  it("cannot be edited or deleted", async () => {
    await reader(providerThat("answers", providerBalance("10.00"))).forAccount(
      TENANT,
      ACCOUNT(),
    );
    await expect(
      harness.db
        .updateTable("balance_observation")
        .set({ available_minor_units: "999999" })
        .execute(),
    ).rejects.toThrow(/append-only/);
  });

  it("stores minor units, never a float", async () => {
    await reader(
      providerThat("answers", providerBalance("1234.50")),
    ).forAccount(TENANT, ACCOUNT());

    const row = await harness.db
      .selectFrom("balance_observation")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.available_minor_units).toBe("123450");
    expect(typeof row.available_minor_units).toBe("string");
  });
});
