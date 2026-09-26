import type { Kysely } from "kysely";
import { sql } from "kysely";
import { Duration } from "@baas/domain";
import type { Clock, IdGenerator } from "@baas/domain";
import { toJsDate } from "@baas/platform";
import type { Database, EffectOutboxTable, OutboxState } from "./schema.js";

/**
 * The outbox (RFC-BaaS §5.6, finding A7).
 *
 * The rule the whole design rests on: **the API never calls a provider for a
 * write.** An effect is recorded in the same transaction as the domain change
 * that justifies it, and a worker is the only thing that dispatches it. That
 * is what turns an unconfirmed 202 from a manual review queue into a state the
 * reconciler owns.
 */
export interface EnqueueEffect {
  readonly tenantId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly providerId: string;
  readonly operation: string;
  readonly payload: unknown;
}

export interface ClaimedEffect {
  readonly id: string;
  readonly tenantId: string;
  readonly providerId: string;
  readonly operation: string;
  readonly payload: unknown;
  readonly attempts: number;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelay: Duration;
  readonly maxDelay: Duration;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 8,
  baseDelay: Duration.ofSeconds(2),
  maxDelay: Duration.ofMinutes(30),
};

/**
 * Exponential backoff with full jitter.
 *
 * Jitter is not decoration. Without it, a provider outage synchronises every
 * pending effect onto the same retry instant and the recovery attempt becomes
 * the second outage.
 */
export function nextDelay(
  attempts: number,
  policy: RetryPolicy,
  random: () => number,
): Duration {
  const exponential =
    policy.baseDelay.milliseconds * 2 ** Math.max(0, attempts - 1);
  const capped = Math.min(exponential, policy.maxDelay.milliseconds);
  return Duration.ofMilliseconds(Math.floor(random() * capped));
}

export class Outbox {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly policy: RetryPolicy = DEFAULT_RETRY,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * Record an effect. Takes an executor so the caller can pass a transaction:
   * the effect and the domain change it justifies must commit together or not
   * at all.
   */
  async enqueue(
    executor: Kysely<Database>,
    effect: EnqueueEffect,
  ): Promise<string> {
    const id = this.ids.next();
    const now = toJsDate(this.clock.now());
    await executor
      .insertInto("effect_outbox")
      .values({
        id,
        tenant_id: effect.tenantId,
        aggregate_type: effect.aggregateType,
        aggregate_id: effect.aggregateId,
        provider_id: effect.providerId,
        operation: effect.operation,
        payload: JSON.stringify(effect.payload),
        state: "pending",
        attempts: 0,
        next_attempt_at: now,
        lease_until: null,
        leased_by: null,
        provider_ref: null,
        last_error: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return id;
  }

  /**
   * Claim due effects under a time-bounded lease.
   *
   * `FOR UPDATE SKIP LOCKED` is what lets N workers run without a leader
   * election: each takes a disjoint set and none blocks on another's rows. The
   * lease, not the lock, is what survives a worker dying mid-dispatch — the
   * row returns to the pool when it expires, exactly once.
   */
  async claim(
    workerId: string,
    limit: number,
    leaseFor: Duration = Duration.ofMinutes(5),
  ): Promise<readonly ClaimedEffect[]> {
    const now = this.clock.now();
    const nowAt = toJsDate(now);
    const leaseUntil = toJsDate(now.plus(leaseFor));

    const result = await sql<EffectOutboxTable>`
      UPDATE effect_outbox SET
        lease_until = ${leaseUntil},
        leased_by   = ${workerId},
        updated_at  = ${nowAt}
      WHERE id IN (
        SELECT id FROM effect_outbox
        WHERE state IN ('pending', 'unknown')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${nowAt})
          AND (lease_until IS NULL OR lease_until <= ${nowAt})
        ORDER BY next_attempt_at NULLS FIRST, created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `.execute(this.db);

    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      providerId: row.provider_id,
      operation: row.operation,
      payload: row.payload,
      attempts: row.attempts,
    }));
  }

  /** The provider accepted the effect. A reference means it can be reconciled. */
  async markDispatched(id: string, providerRef: string): Promise<void> {
    await this.transition(id, "dispatched", { provider_ref: providerRef });
  }

  /** A terminal, successful outcome. */
  async markConfirmed(id: string, providerRef?: string): Promise<void> {
    await this.transition(
      id,
      "confirmed",
      providerRef === undefined ? {} : { provider_ref: providerRef },
    );
  }

  /**
   * The attempt failed and may be retried, or has exhausted its attempts.
   *
   * Exhaustion becomes `unknown`, not `failed`. `failed` means the provider
   * said no; `unknown` means we do not know, and the reconciler owns it
   * (§4.6). Conflating them is how the incumbent's unconfirmed 202 became an
   * operator's problem.
   */
  async recordFailure(
    id: string,
    error: string,
    attempts: number,
  ): Promise<OutboxState> {
    const now = this.clock.now();
    const exhausted = attempts + 1 >= this.policy.maxAttempts;
    const state: OutboxState = exhausted ? "unknown" : "pending";
    const delay = nextDelay(attempts + 1, this.policy, this.random);

    await this.db
      .updateTable("effect_outbox")
      .set({
        state,
        attempts: attempts + 1,
        last_error: error.slice(0, 2000),
        next_attempt_at: exhausted ? null : toJsDate(now.plus(delay)),
        lease_until: null,
        leased_by: null,
        updated_at: toJsDate(now),
      })
      .where("id", "=", id)
      .execute();

    return state;
  }

  /** The provider rejected the effect. Terminal, and not a retry candidate. */
  async markRejected(id: string, reason: string): Promise<void> {
    await this.transition(id, "failed", { last_error: reason.slice(0, 2000) });
  }

  private async transition(
    id: string,
    state: OutboxState,
    extra: Partial<EffectOutboxTable>,
  ): Promise<void> {
    await this.db
      .updateTable("effect_outbox")
      .set({
        ...extra,
        state,
        lease_until: null,
        leased_by: null,
        updated_at: toJsDate(this.clock.now()),
      })
      .where("id", "=", id)
      .execute();
  }
}
