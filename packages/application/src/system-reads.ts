import type { Clock, Instant } from "@baas/domain";
import type { CapabilityReport } from "./capabilities.js";
import { Duration } from "@baas/domain";
import type { ScopedDatabase, TenantScope } from "@baas/persistence";
import { DECLARED_SCHEMA, compareSchema, introspect } from "@baas/persistence";
import { formatInstant, fromJsDate } from "@baas/platform";

/**
 * What an operator currently needs a `psql` prompt for (MP-5).
 *
 * That is the whole specification. Every figure here is one somebody has
 * already gone to the database to find during an incident, and a console that
 * cannot answer them is a console people bypass — after which its audit trail
 * stops describing what was actually looked at.
 *
 * **None of it is audited, and that is deliberate.** These are counts, states
 * and migration ids: no personal data, no customer, no account. A portal
 * dashboard polls, so auditing it would write a row every few seconds and
 * drown the trail that exists to be read. The rule stays "reading a customer
 * is audited", not "reading anything is audited" — the first is a control, the
 * second is noise that hides one.
 */
export interface MigrationState {
  readonly applied: readonly string[];
  readonly lastAppliedAt: string | undefined;
}

export interface SchemaState {
  /** True when the migrated database is exactly what the code declares. */
  readonly matches: boolean;
  /** A column the database has that nothing declares. */
  readonly undeclared: readonly string[];
  /** A column the code declares that the database does not have. */
  readonly missing: readonly string[];
}

export interface QueueDepth {
  readonly state: string;
  readonly count: number;
  /** Age of the oldest row in this state, in seconds. Absent when there are none. */
  readonly oldestAgeSeconds?: number;
}

export interface OutboxState {
  readonly depths: readonly QueueDepth[];
  /**
   * Effects the reconciler has not resolved.
   *
   * Surfaced separately from the depth list because finding A7 turns on it:
   * `unknown` is a state the reconciler owns, and an operator still has to be
   * able to see that it is working. A growing `unknown` count is the single
   * most important number on this screen.
   */
  readonly unresolved: number;
}

export interface InboxState {
  readonly unprocessed: number;
  readonly oldestUnprocessedAgeSeconds?: number;
  /**
   * Deliveries whose signature did not verify.
   *
   * Recorded rather than dropped (New-21), so this is where probing and a
   * rotated credential both show up. A number that is not zero is worth a
   * look; a number that is climbing is worth an alarm.
   */
  readonly rejectedSignatures: number;
}

export interface SystemState {
  readonly migrations: MigrationState;
  readonly schema: SchemaState;
  readonly outbox: OutboxState;
  readonly inbox: InboxState;
  /**
   * What is on, and why (MP-8, finding A8).
   *
   * Carried here rather than left at `/system/capabilities`, because that
   * route authenticates with an **API client credential** and the portal is a
   * browser that must never hold one. Two surfaces answering the same question
   * from the same registry is fine; a console that cannot ask it is not.
   */
  readonly capabilities: CapabilityReport;
}

/** Outbox states that mean "nobody has decided what happened yet". */
const UNRESOLVED = new Set(["pending", "dispatched", "unknown"]);

export class SystemReads {
  constructor(
    private readonly scope: TenantScope,
    private readonly clock: Clock,
    private readonly capabilities: { report(): CapabilityReport },
  ) {}

  async state(tenantId: string): Promise<SystemState> {
    const [migrations, schema] = await Promise.all([
      this.migrations(),
      this.schema(),
    ]);
    return {
      migrations,
      schema,
      capabilities: this.capabilities.report(),
      ...(await this.scope.run(tenantId, async (db) => ({
        outbox: await this.outbox(db),
        inbox: await this.inbox(db),
      }))),
    };
  }

  /**
   * The drift check, **reported** rather than only run in CI.
   *
   * Finding C1 is a readiness probe that trusts the migration ledger: the
   * incumbent reports healthy when a migration is recorded, even if its
   * statements did not apply. Readiness already asserts the schema; this says
   * *what* disagrees, which is the part somebody needs at three in the
   * morning.
   */
  async schema(): Promise<SchemaState> {
    // Through `registry()`, the named exception for a table that cannot be
    // tenant-scoped. The boundary gate refused the first version of this file
    // for taking a raw `Kysely` — rightly: a second database handle in the
    // application layer is a way round `TenantScope` that nobody declared.
    const report = await this.scope.registry(async (db) =>
      compareSchema(await introspect(db), DECLARED_SCHEMA),
    );
    return {
      matches: report.undeclared.length === 0 && report.missing.length === 0,
      undeclared: report.undeclared,
      missing: report.missing,
    };
  }

  async migrations(): Promise<MigrationState> {
    const rows = await this.scope.registry((db) =>
      db
        .selectFrom("schema_migration")
        .select(["id", "applied_at"])
        .orderBy("id")
        .execute(),
    );
    const last = rows.at(-1);
    return {
      applied: rows.map((row) => row.id),
      lastAppliedAt:
        last === undefined
          ? undefined
          : formatInstant(fromJsDate(last.applied_at)),
    };
  }

  private async outbox(db: ScopedDatabase): Promise<OutboxState> {
    const rows = await db
      .selectFrom("effect_outbox")
      .select(({ fn }) => [
        "state",
        fn.count<string>("id").as("count"),
        fn.min("created_at").as("oldest"),
      ])
      .groupBy("state")
      .execute();

    const now = this.clock.now();
    return {
      depths: rows
        .map((row) => toDepth(row.state, row.count, row.oldest, now))
        .sort((left, right) => left.state.localeCompare(right.state)),
      unresolved: rows
        .filter((row) => UNRESOLVED.has(row.state))
        .reduce((total, row) => total + Number(row.count), 0),
    };
  }

  private async inbox(db: ScopedDatabase): Promise<InboxState> {
    const [pending] = await db
      .selectFrom("provider_inbox")
      .select(({ fn }) => [
        fn.count<string>("id").as("count"),
        fn.min("received_at").as("oldest"),
      ])
      .where("processed_at", "is", null)
      .execute();

    const [rejected] = await db
      .selectFrom("provider_inbox")
      .select(({ fn }) => fn.count<string>("id").as("count"))
      .where("signature_verified", "=", false)
      .execute();

    const age = ageSeconds(pending?.oldest ?? null, this.clock.now());
    return {
      unprocessed: Number(pending?.count ?? 0),
      ...(age === undefined ? {} : { oldestUnprocessedAgeSeconds: age }),
      rejectedSignatures: Number(rejected?.count ?? 0),
    };
  }
}

function toDepth(
  state: string,
  count: string,
  oldest: Date | null,
  now: Instant,
): QueueDepth {
  const age = ageSeconds(oldest, now);
  return {
    state,
    count: Number(count),
    ...(age === undefined ? {} : { oldestAgeSeconds: age }),
  };
}

/**
 * Seconds, floored, and never negative.
 *
 * A clock that has gone backwards — a test clock, or two hosts disagreeing —
 * must not produce a negative age that reads as a row from the future.
 */
function ageSeconds(oldest: Date | null, now: Instant): number | undefined {
  if (oldest === null) {
    return undefined;
  }
  const elapsed = now.epochMilliseconds - fromJsDate(oldest).epochMilliseconds;
  return Math.floor(Math.max(0, elapsed) / Duration.ofSeconds(1).milliseconds);
}
