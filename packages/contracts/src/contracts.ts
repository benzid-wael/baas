import { z } from "zod";
import { errorResponseSchema } from "./errors.js";
import {
  currencyCodeSchema,
  instantSchema,
  moneySchema,
  slugSchema,
  uuidSchema,
} from "./primitives.js";
import { RegistryBuilder } from "./registry.js";
import type { ContractRegistry } from "./registry.js";

/**
 * The published contract.
 *
 * Only primitives and the error envelope so far. Resource schemas — accounts,
 * beneficiaries, payment orders — arrive with the milestones that build them,
 * because their shape depends on the persistence model (T6) and on design
 * decisions that are still open (O1, O11, O12). Registering a guess now would
 * publish a contract and then break it.
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
    .build();
}
