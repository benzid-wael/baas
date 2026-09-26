import { Controller, Get, Inject } from "@nestjs/common";
import { Public, Roles, Scopes } from "./decorators.js";

export const CAPABILITY_PROVIDER = "baas:CapabilityProvider";

export interface CapabilityProvider {
  capabilities(): Promise<unknown>;
  ready(): Promise<{ ready: boolean; checks: Record<string, boolean> }>;
}

@Controller("system")
export class SystemController {
  constructor(
    @Inject(CAPABILITY_PROVIDER)
    private readonly provider: CapabilityProvider,
  ) {}

  @Get("health")
  @Public()
  health(): { status: "ok" } {
    return { status: "ok" };
  }

  /**
   * Readiness asserts the schema, not the migration ledger (finding C1).
   * The incumbent reports healthy when a migration is *recorded*, even if its
   * statements did not apply.
   */
  @Get("ready")
  @Public()
  ready(): Promise<{ ready: boolean; checks: Record<string, boolean> }> {
    return this.provider.ready();
  }

  /** What is on, and why (finding A8). */
  @Get("capabilities")
  @Roles("operator")
  capabilities(): Promise<unknown> {
    return this.provider.capabilities();
  }

  /**
   * Present deliberately: a route with a declared, empty scope set is a
   * *policy*, and must be distinguishable from a route that declares nothing.
   */
  @Get("version")
  @Scopes()
  version(): { service: string } {
    return { service: "baas" };
  }
}

/**
 * A route that declares nothing, used by the integration test to prove the
 * backstop refuses it. It is never mounted outside that test.
 */
@Controller("unguarded")
export class UnguardedController {
  @Get()
  leak(): { secret: string } {
    return { secret: "this must never be reachable" };
  }
}
