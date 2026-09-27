import type {
  AccountReadPort,
  Clock,
  StatementReadPort,
  TransactionReadPort,
} from "@baas/domain";

/**
 * A provider adapter, as the registry sees it (M1-10, finding A1).
 *
 * Capabilities are **derived from the ports an adapter actually supplies**,
 * not declared in a list beside it. That is the structural answer to finding
 * N3, where Keel's capability array claims `cards` while its adapter has no
 * `cards()` method: here, claiming an operation means passing an
 * implementation of it, so the claim and the code cannot disagree.
 */
export interface ProviderAdapter {
  readonly providerId: string;
  readonly accounts?: AccountReadPort;
  readonly transactions?: TransactionReadPort;
  readonly statements?: StatementReadPort;
}

export const OPERATIONS = [
  "account.read",
  "transaction.read",
  "statement.read",
] as const;

export type Operation = (typeof OPERATIONS)[number];

/**
 * Why a capability is not available. A closed set, because routing,
 * diagnostics and the portal all branch on it — and because "unavailable" with
 * a free-text reason is how the incumbent's failure surfaced three layers
 * away as "No published, available bank payout route".
 */
export type UnavailableReason =
  | "adapter_absent"
  | "not_configured"
  | "disabled_by_configuration"
  | "operation_not_implemented";

export interface CapabilityStatus {
  readonly available: boolean;
  readonly reason?: UnavailableReason;
}

export interface ProviderCapability {
  readonly provider: string;
  readonly available: boolean;
  readonly reason?: UnavailableReason;
  readonly operations: readonly Operation[];
}

export interface CapabilityReport {
  readonly service: string;
  readonly appEnv: "dev" | "stage" | "production";
  readonly tenants: readonly string[];
  readonly providers: readonly ProviderCapability[];
  readonly checkedAt: string;
}

/**
 * What the deployment says about a provider.
 *
 * Separate from the adapter on purpose. Finding A1: an adapter reported itself
 * unavailable because it read an environment variable the provider does not
 * use, `bank_account` silently vanished from routing, and hours went into the
 * policy layer for a defect in the adapter. **An adapter must not know about
 * deployment configuration at all**; the registry composes the two and reports
 * one reason.
 */
export interface ProviderDeployment {
  /** Credentials present for this provider in this tenant's configuration. */
  readonly configured: boolean;
  /** Turned off deliberately, which is different from never having been set up. */
  readonly disabled?: boolean;
}

export interface CapabilityRegistryOptions {
  readonly serviceName: string;
  readonly appEnv: "dev" | "stage" | "production";
  readonly adapters: readonly ProviderAdapter[];
  readonly deployment: ReadonlyMap<string, ProviderDeployment>;
  readonly tenants: readonly string[];
  readonly clock: Clock;
  readonly formatInstant: (instant: ReturnType<Clock["now"]>) => string;
}

export class CapabilityRegistry {
  private readonly byProvider: ReadonlyMap<string, ProviderAdapter>;

  constructor(private readonly options: CapabilityRegistryOptions) {
    this.byProvider = new Map(
      options.adapters.map((adapter) => [adapter.providerId, adapter]),
    );
  }

  /** Which operations this adapter supplies. Derived, never declared. */
  operationsOf(providerId: string): readonly Operation[] {
    const adapter = this.byProvider.get(providerId);
    if (adapter === undefined) {
      return [];
    }
    const found: Operation[] = [];
    if (adapter.accounts !== undefined) found.push("account.read");
    if (adapter.transactions !== undefined) found.push("transaction.read");
    if (adapter.statements !== undefined) found.push("statement.read");
    return found;
  }

  /**
   * One question, one answer, one reason — asked by routing, diagnostics and
   * the portal alike, so they cannot disagree.
   */
  status(providerId: string, operation?: Operation): CapabilityStatus {
    if (!this.byProvider.has(providerId)) {
      return { available: false, reason: "adapter_absent" };
    }

    const deployment = this.options.deployment.get(providerId);
    if (deployment?.disabled === true) {
      return { available: false, reason: "disabled_by_configuration" };
    }
    if (deployment?.configured !== true) {
      return { available: false, reason: "not_configured" };
    }
    if (
      operation !== undefined &&
      !this.operationsOf(providerId).includes(operation)
    ) {
      return { available: false, reason: "operation_not_implemented" };
    }
    return { available: true };
  }

  report(): CapabilityReport {
    return {
      service: this.options.serviceName,
      appEnv: this.options.appEnv,
      tenants: [...this.options.tenants],
      providers: [...this.byProvider.keys()].sort().map((provider) => {
        const status = this.status(provider);
        return {
          provider,
          available: status.available,
          ...(status.reason === undefined ? {} : { reason: status.reason }),
          operations: this.operationsOf(provider),
        };
      }),
      checkedAt: this.options.formatInstant(this.options.clock.now()),
    };
  }
}
