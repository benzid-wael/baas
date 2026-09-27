import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { Duration, Money } from "@baas/domain";
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
import {
  InvalidCursorError,
  TransactionRepository,
  decodeCursor,
  encodeCursor,
} from "./transaction-repository.js";
import type { ProjectedTransaction } from "./transaction-repository.js";

const TENANT = uuidv7();
const START = parseInstant("2026-09-27T15:00:00.000Z");
const USER = "0192f3a4-5b6c-7d8e-8f90-1234567890ab";

let harness: DatabaseHarness;
let scope: TenantScope;
let transactions: TransactionRepository;
let accountId: string;

beforeAll(async () => {
  harness = await startDatabase({
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
  });
  scope = new TenantScope(harness.db);
  transactions = new TransactionRepository();
  await harness.db
    .insertInto("tenant")
    .values({ id: TENANT, slug: "t", name: "T", created_at: toJsDate(START) })
    .execute();
}, 120_000);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  const ids = new SequenceIdGenerator(
    Array.from({ length: 400 }, () => uuidv7()),
  );
  const clock = new TestClock(START);

  await sql`SET session_replication_role = replica`.execute(harness.db);
  await harness.db.deleteFrom("transaction_projection").execute();
  await harness.db.deleteFrom("account").execute();
  await sql`SET session_replication_role = origin`.execute(harness.db);
  await harness.db.deleteFrom("customer").execute();

  const customers = new CustomerRepository(clock, ids);
  const accounts = new AccountRepository(clock, ids);
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

function transaction(
  index: number,
  over: Partial<ProjectedTransaction> = {},
): ProjectedTransaction {
  return {
    providerId: "keel",
    transactionReference: `TXN-${index.toString().padStart(3, "0")}`,
    accountId,
    direction: index % 2 === 0 ? "credit" : "debit",
    amount: Money.of(`${index.toString()}.50`, "AED"),
    status: "settled",
    counterpartyName: `Party ${index.toString()}`,
    narrative: `Reference ${index.toString()}`,
    occurredAt: START.plus(Duration.ofMinutes(index)),
    ...over,
  };
}

const project = (rows: readonly ProjectedTransaction[]) =>
  scope.runAsProjector(TENANT, (db) => transactions.project(db, TENANT, rows));

describe("one writer, structurally (A7)", () => {
  it("refuses a write from an ordinary scope", async () => {
    await expect(
      scope.run(TENANT, (db) =>
        transactions.project(db, TENANT, [transaction(1)]),
      ),
    ).rejects.toThrow(/one writer/);
  });

  it("refuses a write from a provider sync, which is a different act", async () => {
    // "We observed the provider" and "we derived the read model" are
    // different, and sharing a grant would let either do the other's job.
    await expect(
      scope.runAsProviderSync(TENANT, (db) =>
        transactions.project(db, TENANT, [transaction(1)]),
      ),
    ).rejects.toThrow(/one writer/);
  });

  it("accepts a write from the projector", async () => {
    await project([transaction(1)]);
    const page = await scope.run(TENANT, (db) =>
      transactions.page(db, { accountId, limit: 10 }),
    );
    expect(page.transactions).toHaveLength(1);
  });
});

describe("a rebuild produces identical rows", () => {
  it("re-projecting the same input changes nothing", async () => {
    // No surrogate key and no projected_at, so the rows are fully determined
    // by what the provider said. A projection whose rebuild differs cannot be
    // verified against the one it replaced.
    const input = [transaction(1), transaction(2), transaction(3)];
    await project(input);
    const before = await harness.db
      .selectFrom("transaction_projection")
      .selectAll()
      .orderBy("transaction_reference")
      .execute();

    await scope.runAsProjector(TENANT, (db) =>
      transactions.clearAccount(db, accountId),
    );
    await project(input);

    const after = await harness.db
      .selectFrom("transaction_projection")
      .selectAll()
      .orderBy("transaction_reference")
      .execute();
    expect(after).toEqual(before);
  });

  it("re-projecting a changed transaction updates it in place", async () => {
    await project([transaction(1)]);
    await project([transaction(1, { status: "reversed" })]);
    const page = await scope.run(TENANT, (db) =>
      transactions.page(db, { accountId, limit: 10 }),
    );
    expect(page.transactions).toHaveLength(1);
    expect(page.transactions[0]?.status).toBe("reversed");
  });
});

describe("keyset pagination", () => {
  beforeEach(async () => {
    await project(
      Array.from({ length: 25 }, (_, index) => transaction(index + 1)),
    );
  });

  it("returns newest first and pages to the end", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: Awaited<ReturnType<TransactionRepository["page"]>> =
        await scope.run(TENANT, (db) =>
          transactions.page(db, { accountId, limit: 10, cursor }),
        );
      seen.push(...page.transactions.map((t) => t.transactionReference));
      cursor = page.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe("TXN-025");
    expect(seen.at(-1)).toBe("TXN-001");
  });

  it("neither skips nor repeats when rows are inserted mid-page", async () => {
    // An offset would do both. A customer scrolling while a payment settles
    // would see a transaction twice or not at all.
    const first = await scope.run(TENANT, (db) =>
      transactions.page(db, { accountId, limit: 10 }),
    );

    // A newer transaction arrives between pages. It belongs before the
    // cursor, so it must not appear in the next page.
    await project([transaction(99)]);

    const second = await scope.run(TENANT, (db) =>
      transactions.page(db, { accountId, limit: 10, cursor: first.nextCursor }),
    );

    const overlap = second.transactions
      .map((t) => t.transactionReference)
      .filter((reference) =>
        first.transactions.some((t) => t.transactionReference === reference),
      );
    expect(overlap).toEqual([]);
    expect(
      second.transactions.map((t) => t.transactionReference),
    ).not.toContain("TXN-099");
  });

  it("orders transactions sharing an instant by reference, so the order is total", async () => {
    const at = START.plus(Duration.ofHours(1));
    await project([
      transaction(50, { occurredAt: at }),
      transaction(51, { occurredAt: at }),
    ]);
    const page = await scope.run(TENANT, (db) =>
      transactions.page(db, { accountId, limit: 2 }),
    );
    expect(page.transactions.map((t) => t.transactionReference)).toEqual([
      "TXN-051",
      "TXN-050",
    ]);
  });

  it("has no next cursor on the last page", async () => {
    const page = await scope.run(TENANT, (db) =>
      transactions.page(db, { accountId, limit: 100 }),
    );
    expect(page.nextCursor).toBeUndefined();
  });
});

describe("cursors are ours", () => {
  it("round-trips", () => {
    const cursor = encodeCursor(START, "TXN-001");
    expect(decodeCursor(cursor)).toEqual({
      occurredAtMs: START.epochMilliseconds,
      reference: "TXN-001",
    });
  });

  it("rejects one the client invented, without explaining the shape", async () => {
    await expect(
      scope.run(TENANT, (db) =>
        transactions.page(db, { accountId, limit: 10, cursor: "not-a-cursor" }),
      ),
    ).rejects.toThrow(InvalidCursorError);
    expect(new InvalidCursorError().message).not.toMatch(/base64|occurred|:/);
  });
});

describe("money survives the projection", () => {
  it("stores minor units and reads back the same amount", async () => {
    await project([
      transaction(1, { amount: Money.of("1234567890123456.78", "AED") }),
    ]);
    const page = await scope.run(TENANT, (db) =>
      transactions.page(db, { accountId, limit: 1 }),
    );
    expect(page.transactions[0]?.amount.toDecimalString()).toBe(
      "1234567890123456.78",
    );
  });
});
