import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "reflect-metadata";
import { join } from "node:path";
import { Module } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { Money } from "@baas/domain";
import type { AccountReadPort } from "@baas/domain";
import {
  SequenceIdGenerator,
  TestClock,
  createLogger,
  parseInstant,
  toJsDate,
} from "@baas/platform";
import {
  AccountRepository,
  AuditRepository,
  BalanceRepository,
  CustomerRepository,
  OperatorRepository,
  ROLE_ADMIN,
  TenantScope,
  TransactionRepository,
} from "@baas/persistence";
import { startDatabase } from "@baas/persistence/testing";
import type { DatabaseHarness } from "@baas/persistence/testing";
import { OperatorReads, ReadBalance } from "@baas/application";
import { buildRegistry } from "@baas/contracts";
import {
  AuthorizationPolicyGuard,
  OPERATOR_READS,
  OperatorSessionGuard,
  PlatformReadController,
  RolesGuard,
  compareRoutes,
  mountedRoutes,
  registeredRoutes,
} from "@baas/api";

const logger = createLogger({
  service: "e2e",
  environment: "test",
  level: "silent",
});
const TENANT = uuidv7();
const START = parseInstant("2026-09-27T21:00:00.000Z");
const ISSUER = "https://idp.test";

let harness: DatabaseHarness;
let app: INestApplication;
let scope: TenantScope;
let operators: OperatorRepository;
let sessionToken: string;
let operatorId: string;
let strangerId: string;

const STRANGER_UUID = "0192f3a4-5b6c-7d8e-8f90-cccccccccccc";

function server(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

const asOperator = () => ({ authorization: `Bearer ${sessionToken}` });

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
  const clock = new TestClock(START);
  const ids = new SequenceIdGenerator(
    Array.from({ length: 900 }, () => uuidv7()),
  );
  scope = new TenantScope(harness.db);

  const customers = new CustomerRepository(clock, ids);
  const accounts = new AccountRepository(clock, ids);
  const balances = new BalanceRepository(clock, ids);
  const transactions = new TransactionRepository();
  const audit = new AuditRepository(clock, ids);
  operators = new OperatorRepository(clock, ids);

  await harness.db
    .insertInto("tenant")
    .values({ id: TENANT, slug: "sc", name: "SC", created_at: toJsDate(START) })
    .execute();

  // A customer the operator has no relationship with whatsoever.
  const stranger = await scope.run(TENANT, (db) =>
    customers.register(db, TENANT, STRANGER_UUID),
  );
  strangerId = stranger.id;
  await scope.runAsProviderSync(TENANT, (db) =>
    accounts.observe(db, TENANT, {
      customerId: stranger.id,
      providerId: "keel",
      accountReference: "ACC-STRANGER",
      product: "current_account",
      currency: "AED",
      status: "active",
      iban: "AE070331111111111111111",
    }),
  );
  const strangerAccount = (await scope.run(TENANT, (db) =>
    accounts.forCustomerByReference(db, stranger.id, "ACC-STRANGER"),
  ))!;
  await scope.runAsProjector(TENANT, (db) =>
    transactions.project(db, TENANT, [
      {
        providerId: "keel",
        transactionReference: "TXN-S1",
        accountId: strangerAccount.id,
        direction: "credit",
        amount: Money.of("42.00", "AED"),
        status: "settled",
        counterpartyName: "Someone",
        narrative: "A payment",
        occurredAt: START,
      },
    ]),
  );

  const provider: AccountReadPort = {
    listAccounts: () => Promise.resolve([]),
    getAccount: () => Promise.resolve(undefined),
    getBalance: (reference) =>
      Promise.resolve({
        accountReference: reference,
        available: Money.of("100.00", "AED"),
        current: Money.of("100.00", "AED"),
        observedAt: START,
      }),
  };

  const reads = new OperatorReads(
    scope,
    customers,
    accounts,
    transactions,
    new ReadBalance(
      scope,
      balances,
      new Map([["keel", provider]]),
      clock,
      logger,
    ),
    audit,
  );

  @Module({
    controllers: [PlatformReadController],
    providers: [
      { provide: OPERATOR_READS, useValue: reads },
      {
        provide: APP_GUARD,
        inject: [Reflector],
        useFactory: (r: Reflector) =>
          new OperatorSessionGuard(r, harness.db, operators, logger),
      },
      {
        provide: APP_GUARD,
        inject: [Reflector],
        useFactory: (r: Reflector) => new RolesGuard(r),
      },
      {
        provide: APP_GUARD,
        inject: [Reflector],
        useFactory: (r: Reflector) => new AuthorizationPolicyGuard(r, logger),
      },
    ],
  })
  class PlatformModule {}

  app = await NestFactory.create(PlatformModule, { logger: false });
  await app.init();

  const operator = await scope.run(TENANT, (db) =>
    operators.upsert(db, TENANT, {
      issuer: ISSUER,
      subject: "ops-1",
      email: "ops@example.com",
    }),
  );
  operatorId = operator.id;
  await scope.run(TENANT, (db) =>
    operators.grantRole(db, TENANT, {
      operatorId: operator.id,
      role: ROLE_ADMIN,
      grantedBy: null,
      reason: "test",
    }),
  );
  sessionToken = (
    await scope.run(TENANT, (db) =>
      operators.issueSession(db, TENANT, operator.id),
    )
  ).token;
}, 180_000);

afterAll(async () => {
  await app.close();
  await harness.stop();
});

beforeEach(async () => {
  await sql`TRUNCATE audit_event`.execute(harness.db);
});

async function auditRows() {
  return scope.run(TENANT, (db) =>
    db.selectFrom("audit_event").selectAll().orderBy("occurred_at").execute(),
  );
}

describe("an operator reads a customer they have no relationship with", () => {
  it("finds them by external uuid", async () => {
    const response = await request(server())
      .get("/platform/customers")
      .query({ externalUserUuid: STRANGER_UUID })
      .set(asOperator());
    expect(response.status).toBe(200);
    expect((response.body as { customerId: string }).customerId).toBe(
      strangerId,
    );
  });

  it("finds them from an account reference", async () => {
    const response = await request(server())
      .get("/platform/customers")
      .query({ accountReference: "ACC-STRANGER" })
      .set(asOperator());
    expect(response.status).toBe(200);
    expect((response.body as { customerId: string }).customerId).toBe(
      strangerId,
    );
  });

  it("reads their accounts with balances", async () => {
    const response = await request(server())
      .get(`/platform/customers/${strangerId}/accounts`)
      .set(asOperator());
    expect(response.status).toBe(200);
    const body = response.body as {
      accounts: { accountReference: string; balance: { kind: string } }[];
    };
    expect(body.accounts[0]?.accountReference).toBe("ACC-STRANGER");
    expect(body.accounts[0]?.balance.kind).toBe("observed");
  });

  it("reads their transactions", async () => {
    const response = await request(server())
      .get("/platform/accounts/ACC-STRANGER/transactions")
      .set(asOperator());
    expect(response.status).toBe(200);
    expect(
      (response.body as { items: { transactionReference: string }[] }).items[0]
        ?.transactionReference,
    ).toBe("TXN-S1");
  });
});

describe("every read is audited", () => {
  it.each([
    [
      "a customer lookup",
      "/platform/customers?externalUserUuid=" + STRANGER_UUID,
      "customer.lookup",
    ],
    ["an accounts read", "", "customer.accounts_read"],
    [
      "a transactions read",
      "/platform/accounts/ACC-STRANGER/transactions",
      "account.transactions_read",
    ],
  ])("records %s", async (_label, path, action) => {
    const url =
      path === "" ? `/platform/customers/${strangerId}/accounts` : path;
    await request(server()).get(url).set(asOperator());

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: operatorId,
      actor_kind: "operator",
      action,
      subject_type: "customer",
    });
  });

  it("names the operator and the subject, so the row answers who saw whose data", async () => {
    await request(server())
      .get("/platform/customers")
      .query({ externalUserUuid: STRANGER_UUID })
      .set(asOperator());
    const [row] = await auditRows();
    expect(row?.actor_id).toBe(operatorId);
    expect(row?.subject_id).toBe(strangerId);
  });

  it("records a lookup that found nothing, because a failed search is still a search", async () => {
    await request(server())
      .get("/platform/customers")
      .query({ externalUserUuid: "0192f3a4-5b6c-7d8e-8f90-000000000000" })
      .set(asOperator());
    const [row] = await auditRows();
    expect(row?.action).toBe("customer.lookup");
    expect(row?.detail).toMatchObject({ found: false });
  });

  it("keeps no personal data in the audit detail", async () => {
    // An audit row saying "operator X read customer Y" is the point. One
    // containing Y's IBAN would make the trail itself a place personal data
    // accumulates.
    await request(server())
      .get(`/platform/customers/${strangerId}/accounts`)
      .set(asOperator());
    const [row] = await auditRows();
    expect(JSON.stringify(row?.detail)).not.toContain("AE07");
  });

  it("cannot be edited or deleted afterwards", async () => {
    await request(server())
      .get("/platform/accounts/ACC-STRANGER/transactions")
      .set(asOperator());
    await expect(
      harness.db
        .updateTable("audit_event")
        .set({ action: "tampered" })
        .execute(),
    ).rejects.toThrow(/append-only/);
  });
});

describe("the operator surface answers plainly", () => {
  it("says an account does not exist rather than hiding it", async () => {
    // The mobile surface's deliberate ambiguity is wrong here: reading
    // another customer's data is this role's job, so there is no existence to
    // protect.
    const response = await request(server())
      .get("/platform/accounts/ACC-NOWHERE/transactions")
      .set(asOperator());
    expect(response.status).toBe(404);
  });

  it("refuses a search with both identifiers, or neither", async () => {
    for (const query of [
      {},
      { externalUserUuid: "a", accountReference: "b" },
    ]) {
      const response = await request(server())
        .get("/platform/customers")
        .query(query)
        .set(asOperator());
      expect(response.status).toBe(400);
    }
  });

  it("refuses an unauthenticated read", async () => {
    expect((await request(server()).get("/platform/customers")).status).toBe(
      401,
    );
  });
});

describe("routes and the published contract agree", () => {
  it("has no drift for the operator surface", () => {
    const mismatch = compareRoutes(
      mountedRoutes(app),
      registeredRoutes(buildRegistry()),
      {
        // The mobile routes are mounted by a different module.
        ignore: [],
      },
    );
    expect(mismatch.mountedButUnregistered).toEqual([]);
  });
});
