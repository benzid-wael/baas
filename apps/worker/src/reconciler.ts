import type { Logger } from "@baas/platform";
import { describeError } from "@baas/platform";
import type { Inbox, Outbox } from "@baas/persistence";

/**
 * The reconciler turns recorded evidence into outcomes (RFC-BaaS §4.6).
 *
 * Two properties, both asserted rather than assumed:
 *
 * **Monotonic.** A late `accepted` never overwrites a `settled`. Providers
 * deliver out of order, and the incumbent has no defence against it.
 *
 * **Idempotent.** The same delivery twice produces one transition, so an
 * at-least-once webhook is safe.
 */
export const OUTCOME_RANK: Readonly<Record<string, number>> = {
  pending: 0,
  unknown: 1,
  dispatched: 2,
  accepted: 2,
  confirmed: 3,
  settled: 3,
  failed: 3,
  rejected: 3,
};

/** True when moving to `next` is forward progress rather than a regression. */
export function isForwardTransition(current: string, next: string): boolean {
  const from = OUTCOME_RANK[current] ?? 0;
  const to = OUTCOME_RANK[next] ?? 0;
  return to > from;
}

export interface InboxEventShape {
  readonly providerRef: string | null;
  readonly state: string;
}

export interface ReconcilerOptions {
  readonly inbox: Inbox;
  readonly outbox: Outbox;
  readonly logger: Logger;
  readonly batchSize?: number;
  /** Maps a stored payload to the outcome it asserts. */
  readonly interpret: (payload: unknown) => InboxEventShape | undefined;
  /** Current state of the effect a reference belongs to. */
  readonly lookup: (
    providerRef: string,
  ) => Promise<{ id: string; state: string } | undefined>;
}

export interface ReconcileRun {
  readonly processed: number;
  readonly applied: number;
  readonly ignored: number;
  readonly unmatched: number;
}

export class Reconciler {
  constructor(private readonly options: ReconcilerOptions) {}

  async runOnce(): Promise<ReconcileRun> {
    const pending = await this.options.inbox.pending(
      this.options.batchSize ?? 50,
    );
    let applied = 0;
    let ignored = 0;
    let unmatched = 0;

    for (const event of pending) {
      try {
        const shape = this.options.interpret(event.payload);
        if (shape?.providerRef == null) {
          await this.options.inbox.markProcessed(
            event.id,
            "event carries no provider reference",
          );
          unmatched += 1;
          continue;
        }

        const effect = await this.options.lookup(shape.providerRef);
        if (effect === undefined) {
          // Not an error: a webhook can legitimately arrive before the
          // dispatcher has recorded its reference. It stays unprocessed and is
          // retried, rather than being consumed and lost.
          unmatched += 1;
          continue;
        }

        if (!isForwardTransition(effect.state, shape.state)) {
          await this.options.inbox.markProcessed(event.id);
          ignored += 1;
          this.options.logger.info(
            { effectId: effect.id, state: effect.state, outcome: shape.state },
            "ignored a non-forward outcome",
          );
          continue;
        }

        if (shape.state === "settled" || shape.state === "confirmed") {
          await this.options.outbox.markConfirmed(effect.id, shape.providerRef);
        } else if (shape.state === "failed" || shape.state === "rejected") {
          await this.options.outbox.markRejected(effect.id, shape.state);
        } else {
          await this.options.outbox.markDispatched(
            effect.id,
            shape.providerRef,
          );
        }

        await this.options.inbox.markProcessed(event.id);
        applied += 1;
      } catch (error) {
        const described = describeError(error);
        await this.options.inbox.markProcessed(event.id, described.message);
        this.options.logger.error(
          { err: described },
          "could not reconcile an inbox event",
        );
      }
    }

    return { processed: pending.length, applied, ignored, unmatched };
  }
}
