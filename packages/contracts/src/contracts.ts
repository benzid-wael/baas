import { z } from "zod";
import { errorResponseSchema } from "./errors.js";
import {
  currencyCodeSchema,
  instantSchema,
  moneySchema,
  slugSchema,
  uuidSchema,
} from "./primitives.js";
import {
  accountListSchema,
  accountSchema,
  balanceSchema,
  statementListSchema,
  statementSchema,
  transactionPageSchema,
  transactionSchema,
} from "./reads.js";
import { RegistryBuilder } from "./registry.js";
import type { ContractRegistry } from "./registry.js";

/**
 * The published contract.
 *
 * Primitives, the error envelope, and the M1 read surface. Beneficiaries and
 * payment orders arrive with the milestones that build them — their shape
 * depends on decisions that are still open (O1, O11, O12), and registering a
 * guess would publish a contract and then break it.
 *
 * Paths are registered alongside their controllers, not ahead of them: a
 * documented endpoint that does not exist is worse than an undocumented one,
 * because a client will be written against it.
 */
export const OPENAPI_TITLE = "baas";

/**
 * Bumped by hand when a breaking change is intended. `pnpm check:openapi`
 * refuses a breaking change that leaves this alone.
 */
export const OPENAPI_VERSION = "0.1.0";

/** Reported by `/system/capabilities`: what is on, and why (RFC-BaaS §5.5). */
export const capabilityReportSchema = z.object({
  service: z.string(),
  appEnv: z.enum(["dev", "stage", "production"]),
  tenants: z.array(slugSchema),
  providers: z.array(
    z.object({
      provider: slugSchema,
      available: z.boolean(),
      /** Machine-readable, so routing and the portal agree (finding A1). */
      reason: z.string().optional(),
      operations: z.array(slugSchema),
    }),
  ),
  checkedAt: instantSchema,
});

export function buildRegistry(): ContractRegistry {
  return new RegistryBuilder()
    .schema("Money", moneySchema)
    .schema("CurrencyCode", currencyCodeSchema)
    .schema("Instant", instantSchema)
    .schema("Uuid", uuidSchema)
    .schema("Slug", slugSchema)
    .schema("ErrorResponse", errorResponseSchema)
    .schema("CapabilityReport", capabilityReportSchema)
    .schema("Account", accountSchema)
    .schema("AccountList", accountListSchema)
    .schema("Balance", balanceSchema)
    .schema("Transaction", transactionSchema)
    .schema("TransactionPage", transactionPageSchema)
    .schema("Statement", statementSchema)
    .schema("StatementList", statementListSchema)
    .path("/mobile/accounts", {
      get: {
        operationId: "listAccounts",
        summary: "The customer's accounts, each with its balance",
        responses: {
          "200": {
            description: "The customer's accounts",
            schema: "AccountList",
          },
          "401": { description: "Unauthenticated", schema: "ErrorResponse" },
        },
      },
    })
    .path("/mobile/accounts/{accountReference}", {
      get: {
        operationId: "getAccount",
        summary: "One account belonging to the customer",
        responses: {
          "200": { description: "The account", schema: "Account" },
          // 404 and not 403: "forbidden" on an account reference confirms the
          // reference is real to someone who should not know that.
          "404": {
            description: "No such account for this customer",
            schema: "ErrorResponse",
          },
        },
      },
    })
    .path("/mobile/accounts/{accountReference}/transactions", {
      get: {
        operationId: "listTransactions",
        summary: "A page of the account's transactions, newest first",
        responses: {
          "200": {
            description: "A page of transactions",
            schema: "TransactionPage",
          },
          "404": {
            description: "No such account for this customer",
            schema: "ErrorResponse",
          },
        },
      },
    })
    .build();
}
