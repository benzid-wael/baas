import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { Duration } from "@baas/domain";
import type { ProviderCall } from "@baas/domain";
import {
  SequenceIdGenerator,
  TestClock,
  createLogger,
  parseInstant,
  toJsDate,
} from "@baas/platform";
import { startDatabase } from "./harness.js";
import type { DatabaseHarness } from "./harness.js";
import { TenantScope } from "./tenant-scope.js";
import {
  MAX_BODY,
  ProviderRequestLogRepository,
  TenantScopedCallRecorder,
} from "./provider-request-log.js";

const START = parseInstant("2026-09-28T09:00:00.000Z");
const TENANT = uuidv7();
const logger = createLogger({
  service: "t",
  environment: "test",
  level: "silent",
});

let harness: DatabaseHarness;
let scope: TenantScope;
let repository: ProviderRequestLogRepository;

function ids(): SequenceIdGenerator {
  return new SequenceIdGenerator(Array.from({ length: 500 }, () => uuidv7()));
}

function call(overrides: Partial<ProviderCall> = {}): ProviderCall {
  return {
    providerId: "keel",
    operation: "GET /api/baas/v2/accounts",
    outcome: "ok",
    responseStatus: 200,
    requestBody: "",
    responseBody: '{"accounts":[]}',
    startedAt: START,
    durationMs: 42,
    ...overrides,
  };
}

function recorder(
  options: { retention?: Duration; clock?: TestClock } = {},
): TenantScopedCallRecorder {
  return new TenantScopedCallRecorder({
    scope,
    tenantId: TENANT,
    clock: options.clock ?? new TestClock(START),
    ids: ids(),
    logger,
    ...(options.retention === undefined
      ? {}
      : { retention: options.retention }),
  });
}

beforeAll(async () => {
  harness = await startDatabase({
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
  });
  scope = new TenantScope(harness.db);
  repository = new ProviderRequestLogRepository();
  await harness.db
    .insertInto("tenant")
    .values({ id: TENANT, slug: "sc", name: "SC", created_at: toJsDate(START) })
    .execute();
}, 120_000);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await harness.db.deleteFrom("provider_request_log").execute();
});

async function rows(): Promise<
  { request_body: string; response_body: string; outcome: string }[]
> {
  return harness.db
    .selectFrom("provider_request_log")
    .select(["request_body", "response_body", "outcome"])
    .execute();
}

describe("recording a provider call", () => {
  it("writes what happened", async () => {
    await recorder().record(call());
    const row = await harness.db
      .selectFrom("provider_request_log")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.provider_id).toBe("keel");
    expect(row.operation).toBe("GET /api/baas/v2/accounts");
    expect(row.outcome).toBe("ok");
    expect(row.response_status).toBe(200);
    expect(row.duration_ms).toBe(42);
  });

  it("keeps `unreachable` distinct from `rejected`", async () => {
    // The same three-way distinction the outbox makes. A call that never got
    // an answer may still have moved money, and collapsing it into "failed"
    // is how a payment gets made twice.
    await recorder().record(call({ outcome: "unreachable" }));
    await recorder().record(call({ outcome: "rejected", responseStatus: 422 }));
    expect((await rows()).map((row) => row.outcome).sort()).toEqual([
      "rejected",
      "unreachable",
    ]);
  });

  it("scrubs personal data out of the bodies on the way in", async () => {
    // A provider's words are not safer for being in a table than in a log
    // line, and this table exists to be read by people.
    await recorder().record(
      call({
        requestBody: '{"email":"someone@example.com"}',
        responseBody: '{"iban":"AE070331234567890123456"}',
      }),
    );
    const [row] = await rows();
    expect(row?.request_body).not.toContain("someone@example.com");
    expect(row?.request_body).toContain("[redacted]");
    expect(row?.response_body).not.toContain("AE070331234567890123456");
  });

  it("scrubs the error message too", async () => {
    await recorder().record(
      call({
        outcome: "unreachable",
        errorMessage: "could not reach account AE070331234567890123456",
      }),
    );
    const row = await harness.db
      .selectFrom("provider_request_log")
      .select("error_message")
      .executeTakeFirstOrThrow();
    expect(row.error_message).not.toContain("AE070331234567890123456");
  });

  it("scrubs before truncating, not after", async () => {
    // A body clipped first is a body whose tail was never scrubbed. Asserted
    // with the personal data placed beyond the cap.
    const padding = "x".repeat(MAX_BODY);
    await recorder().record(
      call({ responseBody: `${padding}someone@example.com` }),
    );
    const [row] = await rows();
    expect(row?.response_body).not.toContain("someone@example.com");
  });

  it("truncates a very large body, and says that it did", async () => {
    await recorder().record(call({ responseBody: "y".repeat(MAX_BODY * 2) }));
    const [row] = await rows();
    expect(row?.response_body).toContain("[truncated]");
    expect((row?.response_body.length ?? 0) < MAX_BODY * 2).toBe(true);
  });

  it("never rejects, whatever the database does", async () => {
    // The contract on the port. An adapter awaits this on the call path, so a
    // rejection here would turn a logging failure into a failed payment.
    const broken = new TenantScopedCallRecorder({
      scope,
      // A tenant that does not exist: the foreign key refuses the insert.
      tenantId: uuidv7(),
      clock: new TestClock(START),
      ids: ids(),
      logger,
    });
    await expect(broken.record(call())).resolves.toBeUndefined();
    expect(await rows()).toEqual([]);
  });
});

describe("retention", () => {
  it("stamps every row with the time it must be gone by", async () => {
    await recorder({ retention: Duration.ofDays(7) }).record(call());
    const row = await harness.db
      .selectFrom("provider_request_log")
      .select(["started_at", "retention_until"])
      .executeTakeFirstOrThrow();
    expect(row.retention_until.getTime() - row.started_at.getTime()).toBe(
      Duration.ofDays(7).milliseconds,
    );
  });

  it("purges what is past it and keeps what is not", async () => {
    const short = recorder({ retention: Duration.ofDays(1) });
    const long = recorder({ retention: Duration.ofDays(90) });
    await short.record(call({ operation: "GET /old" }));
    await long.record(call({ operation: "GET /new" }));

    const deleted = await repository.purgeExpired(
      harness.db,
      START.plus(Duration.ofDays(2)),
    );
    expect(deleted).toBe(1);

    const remaining = await harness.db
      .selectFrom("provider_request_log")
      .select("operation")
      .execute();
    expect(remaining.map((row) => row.operation)).toEqual(["GET /new"]);
  });

  it("purges across every tenant, not one at a time", async () => {
    // Retention is an obligation of the service, not a feature of a tenant. A
    // purge that ran per tenant would skip a tenant nobody enumerated.
    const other = uuidv7();
    await harness.db
      .insertInto("tenant")
      .values({
        id: other,
        slug: `o-${other.slice(0, 8)}`,
        name: "Other",
        created_at: toJsDate(START),
      })
      .execute();
    await recorder({ retention: Duration.ofDays(1) }).record(call());
    await new TenantScopedCallRecorder({
      scope,
      tenantId: other,
      clock: new TestClock(START),
      ids: ids(),
      logger,
      retention: Duration.ofDays(1),
    }).record(call());

    expect(
      await repository.purgeExpired(harness.db, START.plus(Duration.ofDays(2))),
    ).toBe(2);
  });

  it("deletes nothing when nothing has expired", async () => {
    await recorder().record(call());
    expect(await repository.purgeExpired(harness.db, START)).toBe(0);
  });
});

describe("reading the log", () => {
  it("pages newest first, and the cursor is stable", async () => {
    for (let index = 0; index < 5; index += 1) {
      await recorder({
        clock: new TestClock(START),
      }).record(
        call({
          operation: `GET /call-${index.toString()}`,
          startedAt: START.plus(Duration.ofSeconds(index)),
        }),
      );
    }

    const first = await scope.run(TENANT, (db) =>
      repository.page(db, { limit: 2 }),
    );
    expect(first.calls.map((entry) => entry.operation)).toEqual([
      "GET /call-4",
      "GET /call-3",
    ]);
    expect(first.nextCursor).toBeDefined();

    const second = await scope.run(TENANT, (db) =>
      repository.page(db, { limit: 2, cursor: first.nextCursor }),
    );
    expect(second.calls.map((entry) => entry.operation)).toEqual([
      "GET /call-2",
      "GET /call-1",
    ]);
  });

  it("stops offering a cursor at the end", async () => {
    await recorder().record(call());
    const page = await scope.run(TENANT, (db) =>
      repository.page(db, { limit: 10 }),
    );
    expect(page.nextCursor).toBeUndefined();
  });

  it("narrows by provider and by correlation id", async () => {
    await recorder().record(call({ providerId: "keel" }));
    await recorder().record(
      call({ providerId: "ruya", correlationId: "corr-1" }),
    );

    expect(
      (
        await scope.run(TENANT, (db) =>
          repository.page(db, { limit: 10, providerId: "ruya" }),
        )
      ).calls,
    ).toHaveLength(1);
    expect(
      (
        await scope.run(TENANT, (db) =>
          repository.page(db, { limit: 10, correlationId: "corr-1" }),
        )
      ).calls,
    ).toHaveLength(1);
  });

  it("refuses a cursor it did not issue, without explaining the shape", async () => {
    await expect(
      scope.run(TENANT, (db) =>
        repository.page(db, { limit: 10, cursor: "not-a-cursor" }),
      ),
    ).rejects.toThrow(/not one this service issued/);
  });

  it("fetches one by id", async () => {
    await recorder().record(call());
    const [row] = await harness.db
      .selectFrom("provider_request_log")
      .select("id")
      .execute();
    const found = await scope.run(TENANT, (db) =>
      repository.byId(db, row?.id ?? ""),
    );
    expect(found?.providerId).toBe("keel");
    expect(await scope.run(TENANT, (db) => repository.byId(db, uuidv7()))).toBe(
      undefined,
    );
  });
});

describe("the log is evidence, so it cannot be edited", () => {
  it("grants no UPDATE to the application role", async () => {
    // Enforced by the absence of a grant rather than by convention. Checked
    // as the application role, because the harness connects as a superuser
    // and a superuser would sail through.
    await recorder().record(call());
    await expect(
      harness.db.connection().execute(async (conn) => {
        await conn.transaction().execute(async (trx) => {
          await sql`SET LOCAL ROLE baas_app`.execute(trx);
          await sql`SELECT set_config('app.tenant_id', ${TENANT}, true)`.execute(
            trx,
          );
          await sql`UPDATE provider_request_log SET operation = 'tampered'`.execute(
            trx,
          );
        });
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("isolates one tenant's calls from another's", async () => {
    const other = uuidv7();
    await harness.db
      .insertInto("tenant")
      .values({
        id: other,
        slug: `i-${other.slice(0, 8)}`,
        name: "Other",
        created_at: toJsDate(START),
      })
      .execute();
    await recorder().record(call());

    expect(
      (await scope.run(other, (db) => repository.page(db, { limit: 10 })))
        .calls,
    ).toEqual([]);
  });
});
