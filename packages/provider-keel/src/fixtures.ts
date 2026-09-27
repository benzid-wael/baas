import type { KeelAccountSummary, KeelTransactionSummary } from "./mapper.js";

/**
 * Recorded provider shapes.
 *
 * Contract tests assert both directions against these: that the request we
 * build matches Keel's schema, and that a response Keel produces maps to the
 * domain type (finding E5). They are fixtures rather than live calls so the
 * suite needs no sandbox and no credentials.
 */
export const ACCOUNT_FIXTURE: KeelAccountSummary = {
  accountId: "acc-1",
  ownerId: "owner-1",
  iban: "AE070331234567890123456",
  bic: "KEELAEAD",
  accountNumber: "01234567",
  sortCode: "04-00-75",
  currencyCode: "AED",
  accountType: "CURRENT",
  status: "ACTIVE",
  balance: "1300.00",
  availableBalance: "1234.50",
  createdAt: "2026-01-15T09:30:00.000Z",
  balanceObservedAt: "2026-09-27T11:59:00.000Z",
};

export const TRANSACTIONS_FIXTURE: {
  transactions: KeelTransactionSummary[];
  nextCursor: string | null;
} = {
  transactions: [
    {
      transactionId: "txn-1",
      reference: "Invoice 4471",
      transactionType: "TRANSFER",
      status: "COMPLETED",
      amount: "250.00",
      currencyCode: "AED",
      debtorAccountId: "acc-1",
      debtorName: "A Customer",
      creditorAccountId: "acc-external",
      creditorName: "Acme Supplies",
      isReversal: false,
      createdAt: "2026-09-20T08:00:00.000Z",
      updatedAt: "2026-09-20T08:00:05.000Z",
    },
    {
      transactionId: "txn-2",
      reference: "Salary September",
      transactionType: "TRANSFER",
      status: "SETTLED",
      amount: "8000.00",
      currencyCode: "AED",
      debtorAccountId: "acc-payroll",
      debtorName: "Payroll Ltd",
      creditorAccountId: "acc-1",
      creditorName: "A Customer",
      isReversal: false,
      createdAt: "2026-09-25T06:00:00.000Z",
      updatedAt: "2026-09-25T06:00:02.000Z",
    },
  ],
  nextCursor: "cur-3",
};
