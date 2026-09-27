import { Money, toCurrencyCode } from "@baas/domain";
import type {
  ProviderAccount,
  ProviderBalance,
  ProviderTransaction,
} from "@baas/domain";
import { parseInstant } from "@baas/platform";
import type { Instant } from "@baas/domain";

/**
 * Keel's wire shapes, as the incumbent records them. Every field is nullable
 * because Keel genuinely omits them, and a mapper that assumes otherwise
 * fails on the first sandbox account with no IBAN.
 */
export interface KeelAccountSummary {
  accountId: string;
  ownerId: string | null;
  iban: string | null;
  bic: string | null;
  accountNumber: string | null;
  sortCode: string | null;
  currencyCode: string | null;
  accountType: string | null;
  status: string | null;
  balance: string | null;
  availableBalance: string | null;
  createdAt: string | null;
  balanceObservedAt?: string | null;
}

export interface KeelTransactionSummary {
  transactionId: string;
  reference: string | null;
  transactionType: string | null;
  status: string | null;
  amount: string | null;
  currencyCode: string | null;
  debtorAccountId: string | null;
  debtorName: string | null;
  creditorAccountId: string | null;
  creditorName: string | null;
  isReversal: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Unknown maps to `unknown`, never to a plausible default.
 *
 * A status we do not recognise becoming `active` is how a closed account gets
 * shown as usable. `unknown` is a first-class state everywhere in this system
 * for the same reason.
 */
const ACCOUNT_STATUS: Readonly<Record<string, ProviderAccount["status"]>> = {
  ACTIVE: "active",
  OPEN: "active",
  PENDING: "pending",
  PENDING_ACTIVATION: "pending",
  FROZEN: "frozen",
  BLOCKED: "frozen",
  CLOSED: "closed",
  TERMINATED: "closed",
};

const TRANSACTION_STATUS: Readonly<
  Record<string, ProviderTransaction["status"]>
> = {
  PENDING: "pending",
  PROCESSING: "pending",
  COMPLETED: "settled",
  SETTLED: "settled",
  FAILED: "rejected",
  REJECTED: "rejected",
  REVERSED: "reversed",
};

const PRODUCT: Readonly<Record<string, ProviderAccount["product"]>> = {
  CURRENT: "current_account",
  CURRENT_ACCOUNT: "current_account",
  WALLET: "wallet",
  SAVINGS: "savings",
};

export function mapAccount(summary: KeelAccountSummary): ProviderAccount {
  return {
    accountReference: summary.accountId,
    ownerReference: summary.ownerId,
    product: lookup(PRODUCT, summary.accountType) ?? "current_account",
    currency: toCurrencyCode(summary.currencyCode ?? "AED"),
    status: lookup(ACCOUNT_STATUS, summary.status) ?? "unknown",
    iban: summary.iban,
    accountNumber: summary.accountNumber,
    sortCode: summary.sortCode,
    bic: summary.bic,
    openedAt: optionalInstant(summary.createdAt),
  };
}

export function mapBalance(
  summary: KeelAccountSummary,
  observedAt: Instant,
): ProviderBalance | undefined {
  if (summary.availableBalance === null || summary.balance === null) {
    return undefined;
  }
  const currency = toCurrencyCode(summary.currencyCode ?? "AED");
  return {
    accountReference: summary.accountId,
    available: Money.of(summary.availableBalance, currency),
    current: Money.of(summary.balance, currency),
    observedAt:
      optionalInstant(summary.balanceObservedAt ?? null) ?? observedAt,
  };
}

export function mapTransaction(
  summary: KeelTransactionSummary,
  accountReference: string,
): ProviderTransaction {
  const currency = toCurrencyCode(summary.currencyCode ?? "AED");
  const debit = summary.debtorAccountId === accountReference;
  return {
    transactionReference: summary.transactionId,
    accountReference,
    direction: debit ? "debit" : "credit",
    amount: Money.of(summary.amount ?? "0", currency),
    status:
      summary.isReversal === true
        ? "reversed"
        : (lookup(TRANSACTION_STATUS, summary.status) ?? "unknown"),
    counterpartyName: debit ? summary.creditorName : summary.debtorName,
    narrative: summary.reference,
    occurredAt:
      optionalInstant(summary.createdAt) ??
      optionalInstant(summary.updatedAt) ??
      UNKNOWN_TIME,
  };
}

const UNKNOWN_TIME = parseInstant("1970-01-01T00:00:00.000Z");

function lookup<T>(
  table: Readonly<Record<string, T>>,
  key: string | null,
): T | undefined {
  return key === null ? undefined : table[key.toUpperCase()];
}

function optionalInstant(value: string | null | undefined): Instant | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  try {
    return parseInstant(value);
  } catch {
    // A timestamp we cannot parse is not a reason to lose the whole record.
    // It becomes absent, which the caller already has to handle.
    return null;
  }
}
