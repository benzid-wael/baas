import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
} from "@nestjs/common";
import type { BalanceView } from "@baas/domain";
import { fromMoney } from "@baas/contracts";
import type {
  AccountWire,
  BalanceWire,
  TransactionWire,
} from "@baas/contracts";
import type {
  AccountView,
  ReadAccounts,
  ReadTransactions,
} from "@baas/application";
import type { ProjectedTransaction } from "@baas/persistence";
import { formatInstant, fromJsDate } from "@baas/platform";
import { MobileSurface, Scopes } from "./decorators.js";
import { principalOf } from "./principal.js";
import type { Principal, RequestWithPrincipal } from "./principal.js";

export const READ_ACCOUNTS = "baas:ReadAccounts";
export const READ_TRANSACTIONS = "baas:ReadTransactions";

export const MOBILE_SCOPES = {
  accounts: "mobile:accounts",
  transactions: "mobile:transactions",
} as const;

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;

/**
 * The mobile read surface (M1-8).
 *
 * Reads only. There is no write path on this controller and no reference to
 * the outbox, so nothing here can become a way to move money.
 */
@Controller("mobile")
export class MobileReadController {
  constructor(
    @Inject(READ_ACCOUNTS) private readonly accounts: ReadAccounts,
    @Inject(READ_TRANSACTIONS) private readonly transactions: ReadTransactions,
  ) {}

  @Get("accounts")
  @MobileSurface()
  @Scopes(MOBILE_SCOPES.accounts)
  async list(
    @Req() request: RequestWithPrincipal,
  ): Promise<{ accounts: AccountWire[] }> {
    const principal = customer(request);
    const views = await this.accounts.forCustomer(
      principal.tenantId,
      principal.customerId,
    );
    return { accounts: views.map(toAccountWire) };
  }

  @Get("accounts/:accountReference")
  @MobileSurface()
  @Scopes(MOBILE_SCOPES.accounts)
  async one(
    @Req() request: RequestWithPrincipal,
    @Param("accountReference") accountReference: string,
  ): Promise<AccountWire> {
    const principal = customer(request);
    const view = await this.accounts.one(
      principal.tenantId,
      principal.customerId,
      accountReference,
    );
    if (view === undefined) {
      // 404, never 403. "Forbidden" on an account reference confirms the
      // reference is real to someone who should not know that.
      throw new NotFoundException("no such account");
    }
    return toAccountWire(view);
  }

  @Get("accounts/:accountReference/transactions")
  @MobileSurface()
  @Scopes(MOBILE_SCOPES.transactions)
  async transactionsFor(
    @Req() request: RequestWithPrincipal,
    @Param("accountReference") accountReference: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string,
  ): Promise<{ items: TransactionWire[]; nextCursor?: string }> {
    const principal = customer(request);
    const page = await this.transactions.forAccount(
      principal.tenantId,
      principal.customerId,
      accountReference,
      { limit: pageSize(limit), ...(cursor === undefined ? {} : { cursor }) },
    );
    if (page === undefined) {
      throw new NotFoundException("no such account");
    }
    return {
      items: page.transactions.map((transaction) =>
        toTransactionWire(transaction, accountReference),
      ),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }
}

/**
 * A mobile-surface route always has a customer by the time it runs — the
 * guard chain refuses otherwise — but saying so in the type is better than
 * asserting it in prose.
 */
function customer(
  request: RequestWithPrincipal,
): Principal & { customerId: string } {
  const principal = principalOf(request);
  /* c8 ignore next 3 -- UserUuidResolverGuard has already refused this case */
  if (principal?.customerId === undefined) {
    throw new NotFoundException("no such account");
  }
  return principal as Principal & { customerId: string };
}

/** Clamped rather than rejected: a client asking for too much gets the maximum. */
function pageSize(raw: string | undefined): number {
  const parsed = Number(raw ?? DEFAULT_PAGE);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_PAGE;
  }
  return Math.min(parsed, MAX_PAGE);
}

function toAccountWire(view: AccountView): AccountWire {
  const { account } = view;
  return {
    accountReference: account.accountReference,
    providerId: account.providerId,
    product: account.product,
    currency: account.currency,
    status: account.status,
    statusReason: account.statusReason,
    iban: account.iban,
    accountNumber: account.accountNumber,
    sortCode: account.sortCode,
    bic: account.bic,
    openedAt:
      account.openedAt === null
        ? null
        : formatInstant(fromJsDate(account.openedAt)),
    balance: toBalanceWire(view.balance),
  };
}

function toBalanceWire(balance: BalanceView): BalanceWire {
  if (balance.kind === "unavailable") {
    return { kind: "unavailable", reason: balance.reason };
  }
  return {
    kind: "observed",
    available: fromMoney(balance.available),
    current: fromMoney(balance.current),
    observedAt: formatInstant(balance.observedAt),
    // Seconds, floored, and never negative: a clock that has moved backwards
    // must not surface as a balance from the future.
    ageSeconds: Math.max(0, Math.floor(balance.age.milliseconds / 1000)),
    fresh: balance.fresh,
  };
}

function toTransactionWire(
  transaction: ProjectedTransaction,
  accountReference: string,
): TransactionWire {
  return {
    transactionReference: transaction.transactionReference,
    accountReference,
    direction: transaction.direction,
    amount: fromMoney(transaction.amount),
    status: transaction.status,
    counterpartyName: transaction.counterpartyName,
    narrative: transaction.narrative,
    occurredAt: formatInstant(transaction.occurredAt),
  };
}
