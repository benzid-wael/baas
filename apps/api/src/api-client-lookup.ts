import type { ApiClientRepository, TenantScope } from "@baas/persistence";
import type { ApiClientLookup, ApiClientRecord } from "./guards.js";

/**
 * The guard chain's client authentication, backed by the registry (New-18).
 *
 * Deliberately the same shape as `RegistryCustomerLookup`: both resolve an
 * identity the request claims, and both do it through a named registry read
 * rather than an ordinary query that happens to skip the tenant scope.
 */
export class RegistryApiClientLookup implements ApiClientLookup {
  constructor(
    private readonly scope: TenantScope,
    private readonly clients: ApiClientRepository,
  ) {}

  async byClientId(clientId: string): Promise<ApiClientRecord | undefined> {
    return this.scope.registry((db) => this.clients.byClientId(db, clientId));
  }
}
