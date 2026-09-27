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
      return this.fallback(stored);
    }

    try {
      const fresh = await provider.getBalance(account.accountReference);
      if (fresh === undefined) {
        return this.fallback(stored);
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
      return this.fallback(stored);
    }
  }

  private fallback(stored: BalanceObservation | undefined): BalanceView {
    if (stored === undefined) {
      return { kind: "unavailable", reason: "provider_unreachable" };
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
