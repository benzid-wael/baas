import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import "reflect-metadata";
import { join } from "node:path";
import { Module } from "@nestjs/common";
import { APP_GUARD, NestFactory, Reflector } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
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
  Inbox,
  OperatorRepository,
  Outbox,
  ROLE_ADMIN,
  TenantScope,
} from "@baas/persistence";
import { startDatabase } from "@baas/persistence/testing";
import type { DatabaseHarness } from "@baas/persistence/testing";
import { SystemReads } from "@baas/application";
import {
  AuthorizationPolicyGuard,
  OperatorSessionGuard,
  PlatformReadController,
  RolesGuard,
  SYSTEM_READS,
  OPERATOR_READS,
} from "@baas/api";

/**
 * What an operator can see without a database prompt (MP-5).
 *
 * The two criteria this task exists to meet: **a stuck effect is visible
 * without `psql`**, and **the schema-drift check is reported rather than only
 * run in CI**. Both are asserted below by breaking something and watching the
 * surface say so.
 */
const logger = createLogger({
  service: "e2e",
  environment: "test",
  level: "silent",
});
const START = parseInstant("2026-09-28T14:00:00.000Z");
const TENANT = uuidv7();

let harness: DatabaseHarness;
let app: INestApplication;
let scope: TenantScope;
let outbox: Outbox;
let inbox: Inbox;
let clock: TestClock;
let sessionToken: string;

const asOperator = (): Record<string, string> => ({
  authorization: `Bearer ${sessionToken}`,
});

function ids(): SequenceIdGenerator {
  return new SequenceIdGenerator(Array.from({ length: 300 }, () => uuidv7()));
}

function server(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

interface SystemBody {
  migrations: { applied: string[]; lastAppliedAt?: string };
  schema: { matches: boolean; undeclared: string[]; missing: string[] };
  outbox: {
    depths: { state: string; count: number; oldestAgeSeconds?: number }[];
    unresolved: number;
  };
  inbox: {
    unprocessed: number;
    oldestUnprocessedAgeSeconds?: number;
    rejectedSignatures: number;
  };
}

async function systemState(): Promise<SystemBody> {
  const response = await request(server())
    .get("/platform/system")
    .set(asOperator());
  expect(response.status).toBe(200);
  return response.body as SystemBody;
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
  clock = new TestClock(START);
  scope = new TenantScope(harness.db);
  outbox = new Outbox(harness.db, clock, ids());
  inbox = new Inbox(harness.db, clock, ids());

  await harness.db
    .insertInto("tenant")
    .values({ id: TENANT, slug: "sc", name: "SC", created_at: toJsDate(START) })
    .execute();

  const operators = new OperatorRepository(clock, ids());
  const operator = await scope.run(TENANT, (db) =>
    operators.upsert(db, TENANT, {
      issuer: "https://idp.test",
      subject: "ops-1",
    }),
  );
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

  const system = new SystemReads(scope, clock);

  @Module({
    controllers: [PlatformReadController],
    providers: [
      { provide: SYSTEM_READS, useValue: system },
      // The customer reads are not exercised here; the controller needs the
      // token to construct, and a fake that is never called says so honestly.
      { provide: OPERATOR_READS, useValue: {} },
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
  class SystemModule {}

  app = await NestFactory.create(SystemModule, {
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

beforeEach(async () => {
  await harness.db.deleteFrom("effect_outbox").execute();
  await harness.db.deleteFrom("provider_inbox").execute();
  clock.setTo(START);
});

describe("migrations and schema", () => {
  it("lists every migration that applied, and when the last one did", async () => {
    const body = await systemState();
    expect(body.migrations.applied.length).toBeGreaterThan(0);
    // Ids are the file names, `.sql` included — that is what the ledger
    // stores, and an operator comparing this list to the directory should not
    // have to know about a transformation.
    expect(body.migrations.applied).toContain("0001_core.sql");
    expect(body.migrations.lastAppliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports the schema as matching when it does", async () => {
    expect((await systemState()).schema).toEqual({
      matches: true,
      undeclared: [],
      missing: [],
    });
  });

  it("reports drift, and says what drifted", async () => {
    // The criterion: the drift check is *reported*, not merely run in CI.
    // Finding C1 is a readiness probe that trusts the migration ledger, so the
    // useful answer at three in the morning is which column disagrees.
    await sql`ALTER TABLE tenant ADD COLUMN drifted uuid`.execute(harness.db);
    try {
      const body = await systemState();
      expect(body.schema.matches).toBe(false);
      expect(body.schema.undeclared).toContain("tenant.drifted");
      // The migration ledger is untouched and still looks healthy, which is
      // exactly the gap this reports.
      expect(body.migrations.applied.length).toBeGreaterThan(0);
    } finally {
      await sql`ALTER TABLE tenant DROP COLUMN drifted`.execute(harness.db);
    }
  });
});

describe("a stuck effect is visible without a database prompt", () => {
  async function enqueue(operation: string): Promise<string> {
    return outbox.enqueue(harness.db, {
      tenantId: TENANT,
      aggregateType: "payment_order",
      aggregateId: uuidv7(),
      providerId: "keel",
      operation,
      payload: {},
    });
  }

  it("counts effects by state", async () => {
    await enqueue("payout.one");
    await enqueue("payout.two");
    const body = await systemState();
    expect(body.outbox.depths).toEqual([
      { state: "pending", count: 2, oldestAgeSeconds: 0 },
    ]);
  });

  it("ages the oldest effect in each state", async () => {
    await enqueue("payout.old");
    clock.advanceBy(Duration.ofMinutes(90));
    const body = await systemState();
    expect(body.outbox.depths[0]?.oldestAgeSeconds).toBe(90 * 60);
  });

  it("surfaces `unknown` separately, because the reconciler owns it (A7)", async () => {
    // A growing `unknown` count is the single most important number here: it
    // means we do not know whether the provider acted.
    await enqueue("payout.one");
    await harness.db
      .updateTable("effect_outbox")
      .set({ state: "unknown" })
      .execute();

    const body = await systemState();
    expect(body.outbox.unresolved).toBe(1);
    expect(body.outbox.depths.map((depth) => depth.state)).toEqual(["unknown"]);
  });

  it("does not count a confirmed effect as unresolved", async () => {
    await enqueue("payout.one");
    await harness.db
      .updateTable("effect_outbox")
      .set({ state: "confirmed" })
      .execute();
    const body = await systemState();
    expect(body.outbox.unresolved).toBe(0);
    // The age is reported for every state, terminal ones included: a uniform
    // shape is easier for a client than one where a field appears by state.
    expect(body.outbox.depths).toEqual([
      { state: "confirmed", count: 1, oldestAgeSeconds: 0 },
    ]);
  });

  it("reports an empty outbox as empty, not as absent", async () => {
    const body = await systemState();
    expect(body.outbox).toEqual({ depths: [], unresolved: 0 });
  });
});

describe("the inbox", () => {
  async function deliver(verified: boolean): Promise<void> {
    await inbox.record({
      tenantId: TENANT,
      providerId: "keel",
      externalEventId: uuidv7(),
      eventType: "payout.status",
      providerRef: "REF-1",
      signatureVerified: verified,
      payload: {},
    });
  }

  it("counts unprocessed deliveries and ages the oldest", async () => {
    await deliver(true);
    clock.advanceBy(Duration.ofMinutes(5));
    const body = await systemState();
    expect(body.inbox.unprocessed).toBe(1);
    expect(body.inbox.oldestUnprocessedAgeSeconds).toBe(300);
  });

  it("counts deliveries whose signature did not verify", async () => {
    // Recorded rather than dropped (New-21), so this is where probing and a
    // rotated credential both show up.
    await deliver(false);
    await deliver(false);
    await deliver(true);
    expect((await systemState()).inbox.rejectedSignatures).toBe(2);
  });

  it("omits the age when there is nothing unprocessed", async () => {
    const body = await systemState();
    expect(body.inbox.unprocessed).toBe(0);
    expect(body.inbox.oldestUnprocessedAgeSeconds).toBeUndefined();
  });
});

describe("who can see it", () => {
  it("is refused without an operator session", async () => {
    expect((await request(server()).get("/platform/system")).status).toBe(401);
  });

  it("writes no audit row, because a dashboard polls", async () => {
    // Deliberate. Counts and migration ids are not personal data, and a row
    // every few seconds would bury the trail that exists to be read.
    await sql`TRUNCATE audit_event`.execute(harness.db);
    await systemState();
    const rows = await harness.db
      .selectFrom("audit_event")
      .selectAll()
      .execute();
    expect(rows).toEqual([]);
  });
});
