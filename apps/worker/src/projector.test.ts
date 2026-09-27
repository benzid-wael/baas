import { describe, expect, it, vi } from "vitest";
import { Money } from "@baas/domain";
import type { ProviderTransaction, TransactionReadPort } from "@baas/domain";
import { createLogger, parseInstant } from "@baas/platform";
import { TransactionProjector } from "./projector.js";
import type { ProjectableAccount } from "./projector.js";

const logger = createLogger({
  service: "t",
  environment: "test",
  level: "silent",
});
const AT = parseInstant("2026-09-27T15:00:00.000Z");

const ACCOUNT: ProjectableAccount = {
  tenantId: "tenant-1",
  accountId: "account-1",
  providerId: "keel",
  accountReference: "ACC-1",
};

function transaction(reference: string): ProviderTransaction {
  return {
    transactionReference: reference,
    accountReference: "ACC-1",
    direction: "debit",
    amount: Money.of("10.00", "AED"),
    status: "settled",
    counterpartyName: null,
    narrative: null,
    occurredAt: AT,
  };
}

/** Records what the projector asked for and what it wrote. */
function harness(pages: ProviderTransaction[][]) {
  const written: string[][] = [];
  const cleared: string[] = [];
  let index = 0;

  const provider: TransactionReadPort = {
    listTransactions: () => {
      const page = pages[index] ?? [];
      index += 1;
      return Promise.resolve({
        transactions: page,
        nextCursor:
          index < pages.length ? `cur-${index.toString()}` : undefined,
      });
    },
  };

  const scope = {
    runAsProjector: (_tenant: string, work: (db: never) => Promise<unknown>) =>
      work(undefined as never),
  };

  const transactions = {
    project: (
      _db: never,
      _tenant: string,
      rows: { transactionReference: string }[],
    ) => {
      written.push(rows.map((row) => row.transactionReference));
      return Promise.resolve();
    },
    clearAccount: (_db: never, accountId: string) => {
      cleared.push(accountId);
      return Promise.resolve();
    },
  };

  const projector = new TransactionProjector({
    scope: scope as never,
    transactions: transactions as never,
    providers: new Map([["keel", provider]]),
    logger,
    pageSize: 2,
    maxPages: 10,
  });

  return { projector, written, cleared };
}

describe("projecting an account", () => {
  it("follows the cursor to the end", async () => {
    const { projector, written } = harness([
      [transaction("A"), transaction("B")],
      [transaction("C")],
    ]);
    expect(await projector.projectAccount(ACCOUNT)).toBe(3);
    expect(written).toEqual([["A", "B"], ["C"]]);
  });

  it("writes nothing for an empty page rather than an empty statement", async () => {
    const { projector, written } = harness([[]]);
    expect(await projector.projectAccount(ACCOUNT)).toBe(0);
    expect(written).toEqual([]);
  });

  it("stops after maxPages, so one busy account cannot starve the rest", async () => {
    const pages = Array.from({ length: 30 }, (_, i) => [
      transaction(`T${i.toString()}`),
    ]);
    const { projector, written } = harness(pages);
    await projector.projectAccount(ACCOUNT);
    expect(written.length).toBe(10);
  });

  it("clears first when rebuilding, and not otherwise", async () => {
    // A projection you cannot rebuild is a projection you cannot fix, so the
    // operation exists from the first day.
    const plain = harness([[transaction("A")]]);
    await plain.projector.projectAccount(ACCOUNT);
    expect(plain.cleared).toEqual([]);

    const rebuilt = harness([[transaction("A")]]);
    await rebuilt.projector.projectAccount(ACCOUNT, { rebuild: true });
    expect(rebuilt.cleared).toEqual(["account-1"]);
  });

  it("refuses an account whose adapter is not registered", async () => {
    const { projector } = harness([[]]);
    await expect(
      projector.projectAccount({ ...ACCOUNT, providerId: "ghost" }),
    ).rejects.toThrow(/no adapter registered/);
  });
});

describe("a run", () => {
  it("keeps going when one account fails", async () => {
    // A projector that aborts on the first bad account leaves every account
    // after it stale, and the staleness is invisible.
    const { projector } = harness([[transaction("A")], [transaction("B")]]);
    const run = await projector.runOnce([
      { ...ACCOUNT, providerId: "ghost", accountId: "bad" },
      ACCOUNT,
    ]);
    expect(run).toMatchObject({ accounts: 2, failed: 1 });
    expect(run.projected).toBeGreaterThan(0);
  });

  it("reports what it did", async () => {
    const { projector } = harness([[transaction("A"), transaction("B")]]);
    expect(await projector.runOnce([ACCOUNT])).toEqual({
      accounts: 1,
      projected: 2,
      failed: 0,
    });
  });

  it("logs the account and provider when one fails", async () => {
    const warn = vi.fn();
    const noisy = new TransactionProjector({
      scope: {
        runAsProjector: (_t: string, w: (db: never) => Promise<unknown>) =>
          w(undefined as never),
      } as never,
      transactions: {
        project: () => Promise.resolve(),
        clearAccount: () => Promise.resolve(),
      } as never,
      providers: new Map(),
      logger: { ...logger, warn },
    });
    await noisy.runOnce([ACCOUNT]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-1", providerId: "keel" }),
      expect.stringContaining("could not project"),
    );
  });
});
