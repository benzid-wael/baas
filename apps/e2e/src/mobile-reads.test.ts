import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "reflect-metadata";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Module } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
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
  TransactionRepository,
} from "@baas/persistence";
import { startDatabase } from "@baas/persistence/testing";
import type { DatabaseHarness } from "@baas/persistence/testing";
import { ReadAccounts, ReadBalance, ReadTransactions } from "@baas/application";
import { buildRegistry } from "@baas/contracts";
import {
  ApiClientGuard,
  AuthorizationPolicyGuard,
  MobileReadController,
  READ_ACCOUNTS,
  READ_TRANSACTIONS,
  RegistryCustomerLookup,
  RolesGuard,
  SessionGuard,
  UserUuidResolverGuard,
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
const START = parseInstant("2026-09-27T16:00:00.000Z");
const ALICE = "0192f3a4-5b6c-7d8e-8f90-aaaaaaaaaaaa";
const BOB = "0192f3a4-5b6c-7d8e-8f90-bbbbbbbbbbbb";
const SECRET = "client-secret-for-tests";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

let harness: DatabaseHarness;
let app: INestApplication;
let bobsAccountReference: string;

function assertion(uuid: string): string {
  return jwt.sign({ sub: uuid }, privateKey, {
    algorithm: "ES256",
    issuer: "https://bff.test",
    audience: "baas",
    expiresIn: "60s",
  });
}

function asCustomer(uuid: string): Record<string, string> {
  return {
    "x-sc-client-id": "bff",
    "x-sc-client-secret": SECRET,
    "x-sc-user-uuid": uuid,
    "x-sc-user-assertion": assertion(uuid),
  };
}

function server(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
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

  const clock = new TestClock(START);
  const ids = new SequenceIdGenerator(
    Array.from({ length: 900 }, () => uuidv7()),
  );
  const scope = new TenantScope(harness.db);
  const customers = new CustomerRepository(clock, ids);
  const accounts = new AccountRepository(clock, ids);
  const balances = new BalanceRepository(clock, ids);
  const transactions = new TransactionRepository();

  await harness.db
    .insertInto("tenant")
    .values({ id: TENANT, slug: "sc", name: "SC", created_at: toJsDate(START) })
    .execute();

  // Alice has an account with transactions; Bob has one she must not see.
  const alice = await scope.run(TENANT, (db) =>
    customers.register(db, TENANT, ALICE),
  );
  const bob = await scope.run(TENANT, (db) =>
    customers.register(db, TENANT, BOB),
  );

  for (const [owner, reference] of [
    [alice.id, "ACC-ALICE"],
    [bob.id, "ACC-BOB"],
  ] as const) {
    await scope.runAsProviderSync(TENANT, (db) =>
      accounts.observe(db, TENANT, {
        customerId: owner,
        providerId: "keel",
        accountReference: reference,
        product: "current_account",
        currency: "AED",
        status: "active",
        iban: `AE07033${reference}`,
      }),
    );
  }
  bobsAccountReference = "ACC-BOB";

  const aliceAccount = (await scope.run(TENANT, (db) =>
    accounts.forCustomerByReference(db, alice.id, "ACC-ALICE"),
  ))!;

  await scope.runAsProjector(TENANT, (db) =>
    transactions.project(db, TENANT, [
      {
        providerId: "keel",
        transactionReference: "TXN-1",
        accountId: aliceAccount.id,
        direction: "debit",
        amount: Money.of("250.00", "AED"),
        status: "settled",
        counterpartyName: "Acme Supplies",
        narrative: "Invoice 4471",
        occurredAt: START.minus(Duration.ofDays(1)),
      },
    ]),
  );

  const provider: AccountReadPort = {
    listAccounts: () => Promise.resolve([]),
    getAccount: () => Promise.resolve(undefined),
    getBalance: (reference): Promise<ProviderBalance | undefined> =>
      Promise.resolve({
        accountReference: reference,
        available: Money.of("1234.50", "AED"),
        current: Money.of("1300.00", "AED"),
        observedAt: START,
      }),
  };

  const readBalance = new ReadBalance(
    scope,
    balances,
    new Map([["keel", provider]]),
    clock,
    logger,
  );
  const readAccounts = new ReadAccounts(scope, accounts, readBalance);
  const readTransactions = new ReadTransactions(scope, accounts, transactions);
  const lookup = new RegistryCustomerLookup(scope, customers);

  const clients = {
    byClientId: (id: string) =>
      Promise.resolve(
        id === "bff"
          ? {
              id: "client-1",
              tenantId: TENANT,
              secretHash: bcrypt.hashSync(SECRET, 10),
              disabled: false,
              scopes: ["mobile:accounts", "mobile:transactions"],
              roles: [],
            }
          : undefined,
      ),
  };
  const assertionConfig = {
    publicKeyPem: publicKey,
    issuer: "https://bff.test",
    audience: "baas",
  };

  @Module({
    controllers: [MobileReadController],
    providers: [
      { provide: READ_ACCOUNTS, useValue: readAccounts },
      { provide: READ_TRANSACTIONS, useValue: readTransactions },
      {
        provide: APP_GUARD,
        inject: [Reflector],
        useFactory: (r: Reflector) => new ApiClientGuard(r, clients, logger),
      },
      {
        provide: APP_GUARD,
        inject: [Reflector],
        useFactory: (r: Reflector) =>
          new UserUuidResolverGuard(r, lookup, assertionConfig, logger),
      },
      {
        provide: APP_GUARD,
        inject: [Reflector],
        useFactory: (r: Reflector) => new SessionGuard(r),
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
  class MobileModule {}

  app = await NestFactory.create(MobileModule, {
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
}, 180_000);

afterAll(async () => {
  await app.close();
  await harness.stop();
});

describe("a customer reads their own accounts", () => {
  it("lists them with a balance", async () => {
    const response = await request(server())
      .get("/mobile/accounts")
      .set(asCustomer(ALICE));

    expect(response.status).toBe(200);
    const body = response.body as { accounts: Record<string, unknown>[] };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({
      accountReference: "ACC-ALICE",
      status: "active",
      balance: {
        kind: "observed",
        available: { amount: "1234.50", currency: "AED" },
        fresh: true,
      },
    });
  });

  it("reads one account", async () => {
    const response = await request(server())
      .get("/mobile/accounts/ACC-ALICE")
      .set(asCustomer(ALICE));
    expect(response.status).toBe(200);
    expect(
      (response.body as { accountReference: string }).accountReference,
    ).toBe("ACC-ALICE");
  });

  it("pages transactions", async () => {
    const response = await request(server())
      .get("/mobile/accounts/ACC-ALICE/transactions")
      .set(asCustomer(ALICE));
    expect(response.status).toBe(200);
    const body = response.body as { items: Record<string, unknown>[] };
    expect(body.items[0]).toMatchObject({
      transactionReference: "TXN-1",
      direction: "debit",
      amount: { amount: "250.00", currency: "AED" },
      counterpartyName: "Acme Supplies",
    });
  });
});

describe("a customer cannot read another customer's account", () => {
  it("returns 404, not 403, for an account that exists but is not theirs", async () => {
    // 403 would confirm the reference is real. Absent and forbidden must be
    // the same answer.
    const response = await request(server())
      .get(`/mobile/accounts/${bobsAccountReference}`)
      .set(asCustomer(ALICE));
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain("ACC-BOB");
  });

  it("answers identically for an account that does not exist at all", async () => {
    const real = await request(server())
      .get(`/mobile/accounts/${bobsAccountReference}`)
      .set(asCustomer(ALICE));
    const imaginary = await request(server())
      .get("/mobile/accounts/ACC-NOWHERE")
      .set(asCustomer(ALICE));

    expect(imaginary.status).toBe(real.status);
    expect(imaginary.body).toEqual(real.body);
  });

  it("refuses transactions for an account that is not theirs", async () => {
    const response = await request(server())
      .get(`/mobile/accounts/${bobsAccountReference}/transactions`)
      .set(asCustomer(ALICE));
    expect(response.status).toBe(404);
  });

  it("shows each customer only their own list", async () => {
    const hers = await request(server())
      .get("/mobile/accounts")
      .set(asCustomer(ALICE));
    const his = await request(server())
      .get("/mobile/accounts")
      .set(asCustomer(BOB));
    expect(
      (hers.body as { accounts: { accountReference: string }[] }).accounts.map(
        (a) => a.accountReference,
      ),
    ).toEqual(["ACC-ALICE"]);
    expect(
      (his.body as { accounts: { accountReference: string }[] }).accounts.map(
        (a) => a.accountReference,
      ),
    ).toEqual(["ACC-BOB"]);
  });
});

describe("the guard chain still applies", () => {
  it("refuses an unauthenticated read", async () => {
    expect((await request(server()).get("/mobile/accounts")).status).toBe(401);
  });

  it("refuses a request with a client credential but no user identity", async () => {
    const response = await request(server())
      .get("/mobile/accounts")
      .set({ "x-sc-client-id": "bff", "x-sc-client-secret": SECRET });
    expect(response.status).toBe(401);
  });

  it("refuses an assertion signed for a different audience", async () => {
    const wrong = jwt.sign({ sub: ALICE }, privateKey, {
      algorithm: "ES256",
      issuer: "https://bff.test",
      audience: "someone-else",
      expiresIn: "60s",
    });
    const response = await request(server()).get("/mobile/accounts").set({
      "x-sc-client-id": "bff",
      "x-sc-client-secret": SECRET,
      "x-sc-user-uuid": ALICE,
      "x-sc-user-assertion": wrong,
    });
    expect(response.status).toBe(401);
  });
});

describe("routes and the published contract agree (New-12)", () => {
  it("documents every route this module mounts", () => {
    // Only one direction here. This module mounts the mobile controller and
    // the registry describes the whole application, so `registeredButUnmounted`
    // is meaningless in a partial fixture. The both-directions check belongs
    // to the assembled application, and is asserted in `application.test.ts`.
    expect(
      compareRoutes(mountedRoutes(app), registeredRoutes(buildRegistry()))
        .mountedButUnregistered,
    ).toEqual([]);
  });
});
