import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { uuidv7 } from "uuidv7";
import { Duration } from "@baas/domain";
import {
  SequenceIdGenerator,
  TestClock,
  createLogger,
  parseInstant,
  toJsDate,
} from "@baas/platform";
import { TenantScope, TenantScopedCallRecorder } from "@baas/persistence";
import { startDatabase } from "@baas/persistence/testing";
import type { DatabaseHarness } from "@baas/persistence/testing";
import { buildWorker } from "@baas/worker";

/**
 * Retention runs because the scheduler runs it (MP-2, finding N2).
 *
 * The incumbent has a retention routine that was written and never scheduled,
 * which is worse than not having one: it reads like having one. So the
 * assertion here is deliberately **not** "the purge function deletes expired
 * rows" — that is asserted in persistence, and it is the half the incumbent
 * also had. It is "**a worker built the ordinary way, ticked the ordinary
 * way, deletes them**".
 */
const START = parseInstant("2026-09-28T12:00:00.000Z");
const TENANT = uuidv7();
const logger = createLogger({
  service: "e2e",
  environment: "test",
  level: "silent",
});

let harness: DatabaseHarness;
let scope: TenantScope;

function ids(): SequenceIdGenerator {
  return new SequenceIdGenerator(Array.from({ length: 200 }, () => uuidv7()));
}

async function remaining(): Promise<number> {
  const rows = await harness.db
    .selectFrom("provider_request_log")
    .select("id")
    .execute();
  return rows.length;
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
  scope = new TenantScope(harness.db);
  await harness.db
    .insertInto("tenant")
    .values({ id: TENANT, slug: "sc", name: "SC", created_at: toJsDate(START) })
    .execute();
}, 180_000);

afterAll(async () => {
  await harness.stop();
});

beforeEach(async () => {
  await harness.db.deleteFrom("provider_request_log").execute();
});

async function record(retention: Duration): Promise<void> {
  await new TenantScopedCallRecorder({
    scope,
    tenantId: TENANT,
    clock: new TestClock(START),
    ids: ids(),
    logger,
    retention,
  }).record({
    providerId: "keel",
    operation: "GET /api/baas/v2/accounts",
    outcome: "ok",
    responseStatus: 200,
    requestBody: "",
    responseBody: "{}",
    startedAt: START,
    durationMs: 1,
  });
}

describe("the retention purge is scheduled, not merely written", () => {
  it("is in the job list of a worker built with no providers at all", () => {
    // Unlike the projector, it is unconditional. A deployment that holds
    // provider bodies with nothing deleting them is the worst state this
    // service can be in, and "no adapter configured" must not cause it.
    const worker = buildWorker({
      db: harness.db,
      logger,
      clock: new TestClock(START),
      ids: ids(),
      tenantId: TENANT,
    });
    expect(worker.jobs.map((job) => job.name)).toEqual([
      "purge-provider-request-log",
    ]);
  });

  it("deletes an expired row when the scheduler ticks", async () => {
    await record(Duration.ofDays(1));
    expect(await remaining()).toBe(1);

    const worker = buildWorker({
      db: harness.db,
      logger,
      // Two days later: the row is past its retention.
      clock: new TestClock(START.plus(Duration.ofDays(2))),
      ids: ids(),
      tenantId: TENANT,
    });
    const ran = await worker.scheduler.tick();

    expect(ran).toContain("purge-provider-request-log");
    expect(await remaining()).toBe(0);
  });

  it("leaves a row that is still within its retention", async () => {
    await record(Duration.ofDays(90));
    const worker = buildWorker({
      db: harness.db,
      logger,
      clock: new TestClock(START.plus(Duration.ofDays(2))),
      ids: ids(),
      tenantId: TENANT,
    });
    await worker.scheduler.tick();
    expect(await remaining()).toBe(1);
  });

  it("does not run again before its interval is up", async () => {
    // A purge that ran on every tick would scan the table once a second.
    const clock = new TestClock(START);
    const worker = buildWorker({
      db: harness.db,
      logger,
      clock,
      ids: ids(),
      tenantId: TENANT,
      purgeEvery: Duration.ofMinutes(15),
    });
    expect(await worker.scheduler.tick()).toHaveLength(1);
    expect(await worker.scheduler.tick()).toHaveLength(0);

    clock.advanceBy(Duration.ofMinutes(16));
    expect(await worker.scheduler.tick()).toHaveLength(1);
  });
});
