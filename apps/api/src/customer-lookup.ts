import type { CustomerRepository, TenantScope } from "@baas/persistence";
import type { CustomerLookup } from "./guards.js";

/**
 * The guard chain's customer resolution, backed by the registry (M1-2).
 *
 * Runs inside a tenant scope like every other read, so a forwarded identity
 * cannot resolve to a customer belonging to a different tenant even if the
 * uuid is known — which is the attack the tenant coming from the credential
 * rather than the request is meant to prevent.
 */
export class RegistryCustomerLookup implements CustomerLookup {
  constructor(
    private readonly scope: TenantScope,
    private readonly customers: CustomerRepository,
  ) {}

  async byExternalUuid(
    tenantId: string,
    externalUserUuid: string,
  ): Promise<{ customerId: string } | undefined> {
    const found = await this.scope.run(tenantId, (db) =>
      this.customers.byExternalUuid(db, externalUserUuid),
    );
    return found === undefined ? undefined : { customerId: found.id };
  }
}
