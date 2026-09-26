import type { Logger } from "@baas/platform";
import { describeError } from "@baas/platform";
import type { ClaimedEffect, Outbox } from "@baas/persistence";

/**
 * The dispatcher is the only component permitted to call a provider for a
 * write (RFC-BaaS §3.3).
 *
 * Everything it does is recoverable: the effect existed before the call, its
 * id is the provider's idempotency key, and no outcome — including none — can
 * lose it.
 */
export interface ProviderDispatch {
  /**
   * Send the effect. The returned reference is what the reconciler later
   * matches a webhook against.
   */
  send(effect: ClaimedEffect): Promise<DispatchOutcome>;
}

export type DispatchOutcome =
  | { kind: "accepted"; providerRef: string }
  | { kind: "settled"; providerRef: string }
  | { kind: "rejected"; reason: string };

export interface DispatcherOptions {
  readonly outbox: Outbox;
  readonly providers: ReadonlyMap<string, ProviderDispatch>;
  readonly logger: Logger;
  readonly workerId: string;
  readonly batchSize?: number;
}

export interface DispatchRun {
  readonly claimed: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly retried: number;
  readonly unknown: number;
}

export class Dispatcher {
  constructor(private readonly options: DispatcherOptions) {}

  async runOnce(): Promise<DispatchRun> {
    const claimed = await this.options.outbox.claim(
      this.options.workerId,
      this.options.batchSize ?? 20,
    );

    let accepted = 0;
    let rejected = 0;
    let retried = 0;
    let unknown = 0;

    for (const effect of claimed) {
      const provider = this.options.providers.get(effect.providerId);
      if (provider === undefined) {
        // A configured effect for an adapter that is not present is a
        // configuration error, not a provider failure. It must not be retried
        // into oblivion, and it must be visible.
        await this.options.outbox.markRejected(
          effect.id,
          `no adapter registered for provider "${effect.providerId}"`,
        );
        rejected += 1;
        this.options.logger.error(
          { effectId: effect.id, providerId: effect.providerId },
          "effect has no adapter",
        );
        continue;
      }

      try {
        const outcome = await provider.send(effect);
        switch (outcome.kind) {
          case "accepted":
            await this.options.outbox.markDispatched(
              effect.id,
              outcome.providerRef,
            );
            accepted += 1;
            break;
          case "settled":
            await this.options.outbox.markConfirmed(
              effect.id,
              outcome.providerRef,
            );
            accepted += 1;
            break;
          case "rejected":
            await this.options.outbox.markRejected(effect.id, outcome.reason);
            rejected += 1;
            break;
        }
      } catch (error) {
        // A throw means we do not know whether the provider acted. That is the
        // `unknown` case, and it is the reconciler's, not an operator's.
        const described = describeError(error);
        const state = await this.options.outbox.recordFailure(
          effect.id,
          described.message,
          effect.attempts,
        );
        if (state === "unknown") {
          unknown += 1;
        } else {
          retried += 1;
        }
        this.options.logger.warn(
          {
            effectId: effect.id,
            providerId: effect.providerId,
            state,
            err: described,
          },
          "effect dispatch failed",
        );
      }
    }

    return { claimed: claimed.length, accepted, rejected, retried, unknown };
  }
}
