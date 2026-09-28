import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "reflect-metadata";
import { join } from "node:path";
import { Module } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { Duration, Money } from "@baas/domain";
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
  ProviderRequestLogRepository,
  TenantScopedCallRecorder,
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
import { OperatorReads, ReadBalance, SystemReads } from "@baas/application";
import { buildRegistry } from "@baas/contracts";
import {
  API_CLIENT_ADMIN,
  AuthorizationPolicyGuard,
  OPERATOR_READS,
  SYSTEM_READS,
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

/** This fixture does not exercise capabilities; an empty report says so. */
const EMPTY_CAPABILITIES = {
  service: "baas",
  appEnv: "dev" as const,
  tenants: [],
  providers: [],
  checkedAt: "2026-09-28T00:00:00.000Z",
};

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
    new ProviderRequestLogRepository(),
  );

  @Module({
    controllers: [PlatformReadController],
    providers: [
      { provide: OPERATOR_READS, useValue: reads },
      { provide: API_CLIENT_ADMIN, useValue: {} },
      {
        provide: SYSTEM_READS,
        useValue: new SystemReads(scope, clock, {
          report: () => EMPTY_CAPABILITIES,
        }),
      },
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

  app = await NestFactory.create(PlatformModule, {
    logger: false,
    // Nest aborts the process on an init failure and prints no message at
    // all. Rejecting instead means the next missing provider says so.
    abortOnError: false,
  });
  // Listening, not merely initialised (New-26).
  //
  // Supertest starts a server itself when handed one that is not listening,
  // and **closes it again once the request settles** -- a listen and a close
  // per request. A request dispatched while that close is in flight fails with
  // `socket hang up`, which is what made the suite fail about one run in four.
  // Once the server is already listening, supertest reuses the address and
  // never closes anything. `app.close()` in `afterAll` still shuts it down.
  await app.listen(0);

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
    );
    // One direction only: this fixture mounts the operator controller while
    // the registry describes the whole application. The other direction is
    // asserted against the assembled application in `application.test.ts`.
    expect(mismatch.mountedButUnregistered).toEqual([]);
  });
});

/**
 * The provider request log through the operator surface (MP-2, finding C4).
 *
 * Finding C4 asks for this to be "a first-class product surface, with
 * retention and an operator view, not an implementation detail". The retention
 * half is asserted in persistence; this is the view.
 */
describe("the provider request log", () => {
  beforeEach(async () => {
    await harness.db.deleteFrom("provider_request_log").execute();
  });

  async function seed(
    calls: readonly {
      operation: string;
      provider?: string;
      correlationId?: string;
    }[],
  ): Promise<void> {
    const recorder = new TenantScopedCallRecorder({
      scope,
      tenantId: TENANT,
      clock: new TestClock(START),
      ids: new SequenceIdGenerator(Array.from({ length: 50 }, () => uuidv7())),
      logger,
    });
    for (const [index, entry] of calls.entries()) {
      await recorder.record({
        providerId: entry.provider ?? "keel",
        operation: entry.operation,
        correlationId: entry.correlationId,
        outcome: "ok",
        responseStatus: 200,
        requestBody: "",
        responseBody: '{"email":"someone@example.com"}',
        startedAt: START.plus(Duration.ofSeconds(index)),
        durationMs: 10,
      });
    }
  }

  it("lists calls newest first, without their bodies", async () => {
    // The bodies are the reason this table is the most sensitive in the
    // service. Fifty of them on one screen answers a question that the status
    // and the duration usually answer on their own.
    await seed([{ operation: "GET /one" }, { operation: "GET /two" }]);
    const response = await request(server())
      .get("/platform/provider-requests")
      .set(asOperator());

    expect(response.status).toBe(200);
    const body = response.body as { items: { operation: string }[] };
    expect(body.items.map((item) => item.operation)).toEqual([
      "GET /two",
      "GET /one",
    ]);
    expect(JSON.stringify(body)).not.toContain("responseBody");
  });

  it("returns the bodies only when one call is asked for by id", async () => {
    await seed([{ operation: "GET /one" }]);
    const list = await request(server())
      .get("/platform/provider-requests")
      .set(asOperator());
    const id = (list.body as { items: { id: string }[] }).items[0]?.id ?? "";

    const one = await request(server())
      .get(`/platform/provider-requests/${id}`)
      .set(asOperator());
    expect(one.status).toBe(200);
    const body = one.body as { responseBody: string };
    // Scrubbed on the way in, so the operator sees the shape without the
    // value. The table is a diagnostic, not a copy of the customer record.
    expect(body.responseBody).toContain("[redacted]");
    expect(body.responseBody).not.toContain("someone@example.com");
  });

  it("audits the list read, naming the filter rather than a customer", async () => {
    await seed([{ operation: "GET /one", provider: "ruya" }]);
    await request(server())
      .get("/platform/provider-requests?providerId=ruya")
      .set(asOperator());

    const audit = await harness.db
      .selectFrom("audit_event")
      .selectAll()
      .where("action", "=", "provider_request_log.read")
      .executeTakeFirstOrThrow();
    expect(audit.subject_id).toBe("ruya");
    expect(audit.actor_kind).toBe("operator");
    expect(audit.actor_id).not.toBeNull();
  });

  it("audits fetching one call, by its id", async () => {
    await seed([{ operation: "GET /one" }]);
    const list = await request(server())
      .get("/platform/provider-requests")
      .set(asOperator());
    const id = (list.body as { items: { id: string }[] }).items[0]?.id ?? "";
    await request(server())
      .get(`/platform/provider-requests/${id}`)
      .set(asOperator());

    const audit = await harness.db
      .selectFrom("audit_event")
      .selectAll()
      .where("action", "=", "provider_request_log.read_one")
      .executeTakeFirstOrThrow();
    expect(audit.subject_id).toBe(id);
  });

  it("narrows by correlation id", async () => {
    await seed([
      { operation: "GET /one", correlationId: "corr-1" },
      { operation: "GET /two" },
    ]);
    const response = await request(server())
      .get("/platform/provider-requests?correlationId=corr-1")
      .set(asOperator());
    expect((response.body as { items: unknown[] }).items).toHaveLength(1);
  });

  it("says plainly that a call does not exist", async () => {
    const response = await request(server())
      .get(`/platform/provider-requests/${uuidv7()}`)
      .set(asOperator());
    expect(response.status).toBe(404);
  });

  it("is refused without an operator session", async () => {
    expect(
      (await request(server()).get("/platform/provider-requests")).status,
    ).toBe(401);
  });
});
