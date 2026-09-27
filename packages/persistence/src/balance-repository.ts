import { Money, toCurrencyCode } from "@baas/domain";
import type { Clock, IdGenerator, Instant } from "@baas/domain";
import { fromJsDate, toJsDate } from "@baas/platform";
import type { ScopedDatabase } from "./tenant-scope.js";

export interface BalanceObservation {
  readonly available: Money;
  readonly current: Money;
  readonly observedAt: Instant;
  readonly source: "provider_read" | "reconciled";
}

export interface RecordObservation {
  readonly accountId: string;
  readonly available: Money;
  readonly current: Money;
  readonly observedAt: Instant;
  readonly source: "provider_read" | "reconciled";
}

/**
 * Balance observations (M1-5).
 *
 * Append-only by trigger. The latest row is not the truth — it is the most
 * recent evidence, which is a different claim and the one we can actually
 * support.
 */
export class BalanceRepository {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async record(
    db: ScopedDatabase,
    tenantId: string,
    observation: RecordObservation,
  ): Promise<void> {
    if (observation.available.currency !== observation.current.currency) {
      throw new Error(
        "available and current balances must be in the same currency",
      );
    }
    await db
      .insertInto("balance_observation")
      .values({
        id: this.ids.next(),
        tenant_id: tenantId,
        account_id: observation.accountId,
        currency: observation.available.currency,
        available_minor_units: observation.available.minorUnits.toString(),
        current_minor_units: observation.current.minorUnits.toString(),
        source: observation.source,
        observed_at: toJsDate(observation.observedAt),
        recorded_at: toJsDate(this.clock.now()),
      })
      .execute();
  }

  async latest(
    db: ScopedDatabase,
    accountId: string,
  ): Promise<BalanceObservation | undefined> {
    const row = await db
      .selectFrom("balance_observation")
      .selectAll()
      .where("account_id", "=", accountId)
      .orderBy("observed_at", "desc")
      .limit(1)
      .executeTakeFirst();

    if (row === undefined) {
      return undefined;
    }

    const currency = toCurrencyCode(row.currency);
    return {
      available: Money.fromMinorUnits(
        BigInt(row.available_minor_units),
        currency,
      ),
      current: Money.fromMinorUnits(BigInt(row.current_minor_units), currency),
      observedAt: fromJsDate(row.observed_at),
      source: row.source,
    };
  }
}
