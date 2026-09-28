import { Duration } from "@baas/domain";
import type {
  AccountReadPort,
  BalanceView,
  Clock,
  Instant,
  Money,
} from "@baas/domain";
import type { Logger } from "@baas/platform";
import { describeError } from "@baas/platform";
import type {
  BalanceObservation,
  BalanceRepository,
  ScopedDatabase,
  TenantScope,
} from "@baas/persistence";

/**
 * Reading a balance (M1-5).
 *
 * **The decision this task existed to make**: what a customer sees when the
 * provider is unreachable. Three options were open —
 *
 *   1. fail the whole read
 *   2. return the account with no balance
 *   3. return the last observation, with its age
 *
 * — and this is (3). A retail app that shows nothing because a bank is having
 * a bad minute is worse for the customer than one that shows "1,234.50, as of
 * eleven minutes ago"; and (1) makes one provider's outage take out the
 * account list as well. (3) is also the only option that requires an
 * observation table, which is what makes a balance auditable rather than a
 * number that appeared.
 *
 * Two rules that are not negotiable and are asserted by test:
 *
 * - **A provider error never reaches the customer as a provider error.** The
 *   incumbent returns a `providerErrors` array in a customer-facing response.
 *   Here the view says `unavailable`, in our own vocabulary, and the detail
 *   goes to the log.
 * - **Absent is absent, never zero.** Rendering a missing balance as `0.00`
 *   reads as "you have no money", which is a worse lie than an error
 *   (finding F4).
 */
export interface ReadBalanceOptions {
  /** Newer than this and a stored observation is served without a provider call. */
  readonly freshFor?: Duration;
}

export class ReadBalance {
  private readonly freshFor: Duration;

  constructor(
    private readonly scope: TenantScope,
    private readonly balances: BalanceRepository,
    private readonly providers: ReadonlyMap<string, AccountReadPort>,
    private readonly clock: Clock,
    private readonly logger: Logger,
    options: ReadBalanceOptions = {},
  ) {
    this.freshFor = options.freshFor ?? Duration.ofSeconds(30);
  }

  async forAccount(
    tenantId: string,
    account: { id: string; providerId: string; accountReference: string },
  ): Promise<BalanceView> {
    const stored = await this.scope.run(tenantId, (db) =>
      this.balances.latest(db, account.id),
    );

    if (
      stored !== undefined &&
      this.ageOf(stored.observedAt).milliseconds <= this.freshFor.milliseconds
    ) {
      return this.observed(
        stored.available,
        stored.current,
        stored.observedAt,
        true,
      );
    }

    const provider = this.providers.get(account.providerId);
    if (provider === undefined) {
      // A configured account whose adapter is absent is a deployment problem,
      // not a customer-visible one. Serve what we have.
      this.logger.error(
        { accountId: account.id, providerId: account.providerId },
        "no adapter for the account's provider",
      );
      // Never asked, so `never_observed` — not `provider_unreachable`, which
      // would be a false statement about a provider we did not contact.
      return this.fallback(stored, "never_observed");
    }

    try {
      const fresh = await provider.getBalance(account.accountReference);
      if (fresh === undefined) {
        // The provider answered, and has no balance for this account. That is
        // an absence, not a failure.
        return this.fallback(stored, "never_observed");
      }

      await this.scope.runAsProviderSync(tenantId, (db: ScopedDatabase) =>
        this.balances.record(db, tenantId, {
          accountId: account.id,
          available: fresh.available,
          current: fresh.current,
          observedAt: fresh.observedAt,
          source: "provider_read",
        }),
      );

      return this.observed(
        fresh.available,
        fresh.current,
        fresh.observedAt,
        true,
      );
    } catch (error) {
      this.logger.warn(
        {
          accountId: account.id,
          providerId: account.providerId,
          err: describeError(error),
        },
        "balance read failed; serving the last observation if there is one",
      );
      // The call failed. This is the one case where the provider genuinely
      // could not be reached, and the only one that should say so.
      return this.fallback(stored, "provider_unreachable");
    }
  }

  /**
   * What to serve when there is no fresh figure.
   *
   * The reason is passed in rather than assumed, because the three ways of
   * getting here are not the same thing (correction C15). An earlier version
   * always answered `provider_unreachable`, which made `never_observed`
   * **unreachable in practice** — a dead variant in a closed set the UI is
   * meant to branch on, which is finding A1's shape again: a distinction that
   * exists in the type and never in the answer.
   *
   * For a customer the difference is real: "we do not have this yet" is not an
   * incident, and "we cannot reach your bank right now" might be.
   */
  private fallback(
    stored: BalanceObservation | undefined,
    reason: "never_observed" | "provider_unreachable",
  ): BalanceView {
    if (stored === undefined) {
      return { kind: "unavailable", reason };
    }
    return this.observed(
      stored.available,
      stored.current,
      stored.observedAt,
      false,
    );
  }

  private observed(
    available: Money,
    current: Money,
    observedAt: Instant,
    fresh: boolean,
  ): BalanceView {
    return {
      kind: "observed",
      available,
      current,
      observedAt,
      age: this.ageOf(observedAt),
      fresh,
    };
  }

  private ageOf(observedAt: Instant): Duration {
    return this.clock.now().since(observedAt);
  }
}
