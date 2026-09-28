import { Duration, Money } from "@baas/domain";
import type { Clock, IdGenerator } from "@baas/domain";
import {
  AccountRepository,
  BalanceRepository,
  CustomerRepository,
} from "@baas/persistence";
import type { TenantScope } from "@baas/persistence";
import { SeedRefusedError } from "./seed.js";

/**
 * A customer to look at (New-25).
 *
 * Without one, `/mobile/*` answers 401 at the identity guard and the operator
 * console has nothing to show — so the entire read surface is reachable only
 * from the automated tests. That is the shape of finding N1: a path that works
 * in a test and has never been exercised by a person.
 *
 * **The data is synthetic and obviously so.** No name that could be a person's,
 * no IBAN that could be an account, no number that could be a real balance. A
 * developer copying a row out of here into a ticket should be copying something
 * that is visibly fake.
 */
/**
 * A real uuid — the column is `uuid`, so it has to be — chosen to be
 * unmistakable at a glance. Twelve zeros and a one is not an identifier anybody
 * will confuse with a customer's.
 */
export const DEMO_EXTERNAL_USER_UUID = "0192f3a4-5b6c-7d8e-8f90-000000000001";

export interface DemoDataResult {
  readonly externalUserUuid: string;
  readonly customerId: string;
  readonly accounts: readonly {
    readonly accountReference: string;
    readonly shows: string;
  }[];
}

/**
 * Three accounts, because a balance has three shapes and finding F4 is about
 * showing all of them.
 *
 * A screen built against one shape renders the other two wrong — usually as a
 * confident `0.00`, which reads as "you have no money" and is a worse lie than
 * an error. So the demo data makes all three reachable without a provider:
 *
 *   recent       observed seconds ago
 *   old          observed an hour ago, served because nothing newer exists
 *   unavailable  never observed at all
 *
 * **A caveat found by running it.** With no provider adapter, nothing can
 * refresh an observation, so `fresh: true` only holds for the 30 seconds after
 * seeding — after that the recent account reports `fresh: false` with a small
 * age, and the old one reports `fresh: false` with a large one. That still
 * exercises both `observed` renderings, which is what the screen needs; it
 * just means "seed, then look immediately" is the way to see `fresh: true`.
 * Naming the account `FRESH` and letting it report stale a minute later would
 * be the demo lying about itself.
 */
const ACCOUNTS = [
  {
    reference: "DEMO-ACCT-RECENT",
    currency: "AED",
    available: "1234.50",
    observedAgo: Duration.ofSeconds(5),
    shows: "a balance observed seconds ago (fresh for 30s after seeding)",
  },
  {
    reference: "DEMO-ACCT-OLD",
    currency: "AED",
    available: "87.00",
    observedAgo: Duration.ofHours(1),
    shows: "a balance an hour old — show the age, not just the number",
  },
  {
    reference: "DEMO-ACCT-SILENT",
    currency: "USD",
    available: undefined,
    observedAgo: undefined,
    shows: "no balance at all — absent, never zero",
  },
] as const;

export async function seedDemoData(
  scope: TenantScope,
  clock: Clock,
  ids: IdGenerator,
  options: { readonly appEnv: string; readonly tenantId: string },
): Promise<DemoDataResult> {
  if (options.appEnv !== "dev") {
    throw new SeedRefusedError(options.appEnv);
  }

  const customers = new CustomerRepository(clock, ids);
  const accounts = new AccountRepository(clock, ids);
  const balances = new BalanceRepository(clock, ids);

  const customer = await scope.run(options.tenantId, (db) =>
    customers.register(db, options.tenantId, DEMO_EXTERNAL_USER_UUID),
  );

  for (const account of ACCOUNTS) {
    // `runAsProviderSync`: the account table is derived from what a provider
    // said, and a trigger refuses the write outside that scope. The demo data
    // goes through the same door as a real observation rather than around it.
    await scope.runAsProviderSync(options.tenantId, (db) =>
      accounts.observe(db, options.tenantId, {
        customerId: customer.id,
        providerId: "demo",
        accountReference: account.reference,
        product: "current_account",
        currency: account.currency,
        status: "active",
      }),
    );
  }

  const stored = await scope.run(options.tenantId, (db) =>
    accounts.listForCustomer(db, customer.id),
  );

  for (const account of ACCOUNTS) {
    if (account.available === undefined) {
      continue;
    }
    const record = stored.find(
      (candidate) => candidate.accountReference === account.reference,
    );
    /* c8 ignore next 3 -- written immediately above; a miss is a bug, not a case */
    if (record === undefined) {
      throw new Error(`demo account ${account.reference} was not written`);
    }
    const amount = Money.of(account.available, account.currency);
    await scope.run(options.tenantId, (db) =>
      balances.record(db, options.tenantId, {
        accountId: record.id,
        available: amount,
        current: amount,
        observedAt: clock.now().minus(account.observedAgo),
        source: "provider_read",
      }),
    );
  }

  return {
    externalUserUuid: DEMO_EXTERNAL_USER_UUID,
    customerId: customer.id,
    accounts: ACCOUNTS.map((account) => ({
      accountReference: account.reference,
      shows: account.shows,
    })),
  };
}
