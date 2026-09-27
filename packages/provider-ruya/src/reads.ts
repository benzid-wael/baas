import { Money, toCurrencyCode } from "@baas/domain";
import type {
  AccountReadPort,
  Clock,
  Instant,
  ProviderAccount,
  ProviderBalance,
  ProviderTransaction,
  TransactionPage,
  TransactionReadPort,
} from "@baas/domain";
import { parseInstant } from "@baas/platform";
import type { RuyaHttp } from "./http.js";
import { RuyaApiError } from "./errors.js";

const BALANCE_DETAILS =
  "/ruya/gbprest/accountManagement/account/balanceDetails";
const BALANCE_LIST = "/ruya/accountManagement/account/balanceList";
const TRANSACTIONS = "/ruya/ViewAccountTransactionsDetails";

/**
 * TCS BaNCS wire shapes. Amounts arrive as strings because the transport
 * parses losslessly — see `parseRuyaJson`. Typing them as `string` here is
 * what makes that guarantee visible at the boundary rather than buried in a
 * parser option.
 */
interface RawBalanceDetails {
  accountBalanceDetails?: {
    balance?: {
      accountReference: string;
      amount: { accountBalance: string; balanceAmountCurrency: string };
      creditDebitIndicator?: string;
      dateTime?: string;
    };
  };
}

interface RawAccountListItem {
  accountReference: string;
  accountType?: string;
  accountStatus?: string;
  currency?: string;
  iban?: string;
  accountNumber?: string;
  openDate?: string;
  amount?: { accountBalance?: string; balanceAmountCurrency?: string };
}

interface RawAccountList {
  hasNext?: string;
  accountBalanceList?: RawAccountListItem[];
  accountList?: RawAccountListItem[];
}

interface RawTransaction {
  transactionReference: string;
  amount?: { transactionAmount?: string; currency?: string };
  creditDebitIndicator?: string;
  transactionStatus?: string;
  counterPartyName?: string;
  narrative?: string;
  bookingDateTime?: string;
}

interface RawTransactionResponse {
  transactionDetails?: RawTransaction[];
  hasNext?: string;
  pageNum?: string;
}

const ACCOUNT_STATUS: Readonly<Record<string, ProviderAccount["status"]>> = {
  ACTIVE: "active",
  A: "active",
  DORMANT: "frozen",
  BLOCKED: "frozen",
  CLOSED: "closed",
  C: "closed",
  PENDING: "pending",
};

const TRANSACTION_STATUS: Readonly<
  Record<string, ProviderTransaction["status"]>
> = {
  BOOKED: "settled",
  COMPLETED: "settled",
  PENDING: "pending",
  REJECTED: "rejected",
  REVERSED: "reversed",
};

export class RuyaReads implements AccountReadPort, TransactionReadPort {
  constructor(
    private readonly http: RuyaHttp,
    private readonly clock: Clock,
  ) {}

  async listAccounts(
    ownerReference: string,
  ): Promise<readonly ProviderAccount[]> {
    const raw = await this.http.get<RawAccountList>(BALANCE_LIST, {
      query: { CustomerID: ownerReference, pageNum: 1, pageSize: 22 },
    });
    const items = raw.accountBalanceList ?? raw.accountList ?? [];
    return items.map((item) => this.mapAccount(item, ownerReference));
  }

  async getAccount(
    accountReference: string,
  ): Promise<ProviderAccount | undefined> {
    // BaNCS has no single-account read that returns the whole shape, so a
    // detail read is a list read filtered down. Stated rather than hidden:
    // it is why this call is more expensive than it looks.
    const balance = await this.fetchBalance(accountReference);
    if (balance === undefined) {
      return undefined;
    }
    return {
      accountReference,
      ownerReference: null,
      product: "current_account",
      currency: toCurrencyCode(balance.amount.balanceAmountCurrency),
      status: "unknown",
      iban: null,
      accountNumber: null,
      sortCode: null,
      bic: null,
      openedAt: null,
    };
  }

  async getBalance(
    accountReference: string,
  ): Promise<ProviderBalance | undefined> {
    const balance = await this.fetchBalance(accountReference);
    if (balance === undefined) {
      return undefined;
    }
    const currency = toCurrencyCode(balance.amount.balanceAmountCurrency);
    const amount = Money.of(balance.amount.accountBalance, currency);
    return {
      accountReference: balance.accountReference,
      available: amount,
      // BaNCS reports one balance on this endpoint. Reporting it as both
      // rather than inventing a second is the honest mapping; a caller that
      // needs the distinction must ask a different question.
      current: amount,
      observedAt: instantOr(balance.dateTime, this.clock.now()),
    };
  }

  async listTransactions(request: {
    accountReference: string;
    cursor?: string | undefined;
    limit: number;
  }): Promise<TransactionPage> {
    const page = request.cursor === undefined ? 1 : Number(request.cursor);
    const raw = await this.http.get<RawTransactionResponse>(
      `${TRANSACTIONS}/${encodeURIComponent(request.accountReference)}`,
      { query: { pageNum: page, pageSize: request.limit } },
    );

    const transactions = (raw.transactionDetails ?? []).map((item) =>
      this.mapTransaction(item, request.accountReference),
    );

    return {
      transactions,
      // BaNCS pages by number, not by cursor. The page number is the cursor,
      // which is opaque to the client by contract and therefore allowed to be
      // this.
      nextCursor: raw.hasNext === "Y" ? String(page + 1) : undefined,
    };
  }

  private async fetchBalance(
    accountReference: string,
  ): Promise<
    | NonNullable<
        NonNullable<RawBalanceDetails["accountBalanceDetails"]>["balance"]
      >
    | undefined
  > {
    try {
      const raw = await this.http.get<RawBalanceDetails>(
        `${BALANCE_DETAILS}/${encodeURIComponent(accountReference)}`,
        // The reference goes in the path, so the log records the route.
        { operation: `GET ${BALANCE_DETAILS}/{accountReference}` },
      );
      return raw.accountBalanceDetails?.balance;
    } catch (error) {
      if (error instanceof RuyaApiError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  private mapAccount(
    item: RawAccountListItem,
    ownerReference: string,
  ): ProviderAccount {
    return {
      accountReference: item.accountReference,
      ownerReference,
      product: "current_account",
      currency: toCurrencyCode(
        item.currency ?? item.amount?.balanceAmountCurrency ?? "AED",
      ),
      status: lookup(ACCOUNT_STATUS, item.accountStatus) ?? "unknown",
      iban: item.iban ?? null,
      accountNumber: item.accountNumber ?? null,
      sortCode: null,
      bic: null,
      openedAt: optionalInstant(item.openDate),
    };
  }

  private mapTransaction(
    item: RawTransaction,
    accountReference: string,
  ): ProviderTransaction {
    const currency = toCurrencyCode(item.amount?.currency ?? "AED");
    return {
      transactionReference: item.transactionReference,
      accountReference,
      // BaNCS says D or C rather than naming the parties.
      direction: (item.creditDebitIndicator ?? "D")
        .toUpperCase()
        .startsWith("C")
        ? "credit"
        : "debit",
      amount: Money.of(item.amount?.transactionAmount ?? "0", currency),
      status: lookup(TRANSACTION_STATUS, item.transactionStatus) ?? "unknown",
      counterpartyName: item.counterPartyName ?? null,
      narrative: item.narrative ?? null,
      occurredAt: instantOr(item.bookingDateTime, EPOCH),
    };
  }
}

const EPOCH = parseInstant("1970-01-01T00:00:00.000Z");

function lookup<T>(
  table: Readonly<Record<string, T>>,
  key: string | undefined,
): T | undefined {
  return key === undefined ? undefined : table[key.toUpperCase()];
}

function optionalInstant(value: string | undefined): Instant | null {
  if (value === undefined || value === "") {
    return null;
  }
  try {
    return parseInstant(value);
  } catch {
    return null;
  }
}

function instantOr(value: string | undefined, fallback: Instant): Instant {
  return optionalInstant(value) ?? fallback;
}
