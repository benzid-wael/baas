import { Module } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import type { DynamicModule } from "@nestjs/common";
import type { Logger } from "@baas/platform";
import {
  ApiClientGuard,
  AuthorizationPolicyGuard,
  RolesGuard,
  SessionGuard,
  UserUuidResolverGuard,
} from "./guards.js";
import type { ApiClientLookup, CustomerLookup } from "./guards.js";
import type { AssertionConfig } from "./assertion.js";
import {
  CAPABILITY_PROVIDER,
  SystemController,
  UnguardedController,
} from "./system.controller.js";
import type { CapabilityProvider } from "./system.controller.js";

export interface ApiDependencies {
  readonly clients: ApiClientLookup;
  readonly customers: CustomerLookup;
  readonly assertion: AssertionConfig;
  readonly capabilities: CapabilityProvider;
  readonly logger: Logger;
  /** Test-only: mounts a controller that declares no policy, to prove refusal. */
  readonly mountUnguardedProbe?: boolean;
}

/**
 * Guard order is the contract, and it is declared once, here.
 *
 *   1 ApiClientGuard          authenticate the caller, resolve its tenant
 *   2 UserUuidResolverGuard   resolve a forwarded identity, mobile routes only
 *   3 SessionGuard            a principal must exist by now
 *   4 RolesGuard              role check
 *   5 AuthorizationPolicyGuard a route with no policy is refused
 *
 * Nest applies `APP_GUARD` providers in registration order, so the sequence
 * above is the sequence below. Reordering them is a security change and
 * should read like one.
 */
@Module({})
export class AppModule {
  static withDependencies(deps: ApiDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers:
        deps.mountUnguardedProbe === true
          ? [SystemController, UnguardedController]
          : [SystemController],
      providers: [
        { provide: CAPABILITY_PROVIDER, useValue: deps.capabilities },
        {
          provide: APP_GUARD,
          inject: [Reflector],
          useFactory: (reflector: Reflector) =>
            new ApiClientGuard(reflector, deps.clients, deps.logger),
        },
        {
          provide: APP_GUARD,
          inject: [Reflector],
          useFactory: (reflector: Reflector) =>
            new UserUuidResolverGuard(
              reflector,
              deps.customers,
              deps.assertion,
              deps.logger,
            ),
        },
        {
          provide: APP_GUARD,
          inject: [Reflector],
          useFactory: (reflector: Reflector) => new SessionGuard(reflector),
        },
        {
          provide: APP_GUARD,
          inject: [Reflector],
          useFactory: (reflector: Reflector) => new RolesGuard(reflector),
        },
        {
          provide: APP_GUARD,
          inject: [Reflector],
          useFactory: (reflector: Reflector) =>
            new AuthorizationPolicyGuard(reflector, deps.logger),
        },
      ],
    };
  }
}
